import crypto from 'crypto';
import { PdfikError } from './errors';
import {
  JobCreatedResponse,
  JobStatusResponse,
  JobFileResponse,
  PdfOptions,
  RenderOptions,
  JobAuthOptions,
  EInvoiceOptions,
  EInvoiceProfile,
  ImageOptions,
  DeliveryOptions,
} from './types';

function snakeToCamel(str: string): string {
  return str.replace(/([-_][a-z])/g, (group) =>
    group.toUpperCase().replace('-', '').replace('_', '')
  );
}

function camelToSnake(str: string): string {
  return str.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

function mapKeys(obj: any, fn: (key: string) => string): any {
  if (Array.isArray(obj)) {
    return obj.map((val) => mapKeys(val, fn));
  } else if (obj !== null && typeof obj === 'object') {
    return Object.keys(obj).reduce((acc: any, key: string) => {
      acc[fn(key)] = mapKeys(obj[key], fn);
      return acc;
    }, {});
  }
  return obj;
}

function normalizeDelivery(delivery?: DeliveryOptions): DeliveryOptions | undefined {
  if (!delivery) {
    return undefined;
  }
  // `mode` may be omitted by the caller; the wire format spells it out.
  return { mode: delivery.mode ?? 'presigned_put', url: delivery.url };
}

function validateRenderOptions(render?: RenderOptions): void {
  if (render?.waitAfterLoadMs !== undefined) {
    const v = render.waitAfterLoadMs;
    if (typeof v !== 'number' || Number.isNaN(v) || v < 0 || v > 10000) {
      throw new Error('waitAfterLoadMs must be between 0 and 10000 ms');
    }
  }
}

export interface PdfikClientConfig {
  apiKey: string;
  baseUrl?: string;
}

const MAX_ATTEMPTS = 3;
const BACKOFF_INITIAL_MS = 1000;
// A throttle is waited out, not counted as a failed attempt — but not forever:
// after this many waits the 429 is thrown.
const THROTTLE_WAITS = 5;
const RETRY_AFTER_FALLBACK_MS = 10000;
const RETRY_AFTER_CAP_SECONDS = 60; // the server states the wait; it must not be able to park the caller

function problemBody(error: PdfikError): Record<string, unknown> {
  try {
    const data = JSON.parse(error.responseBody || '{}');
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

/** Whether the error is the documented case `slug`: the fragment of its `type`
 * URL (https://docs.pdfik.net/error-codes#<slug>) or the `error` code spelled in
 * upper snake case. */
function isCase(error: PdfikError, slug: string): boolean {
  const type = problemBody(error).type;
  if (typeof type === 'string' && type.endsWith(`#${slug}`)) return true;
  return error.errorCode?.toUpperCase() === slug.replace(/-/g, '_').toUpperCase();
}

/** The two 429s that clear by themselves within a minute — the per-account
 * request rate and the in-flight job cap. A quota 429 (monthly bytes), the
 * test-mode caps and an exhausted download counter do not, so they are thrown
 * at once. */
function isThrottled(error: PdfikError): boolean {
  return (
    error.statusCode === 429 &&
    (isCase(error, 'rate-limit-exceeded') || isCase(error, 'concurrency-limit-exceeded'))
  );
}

/** The download has a third 429 that clears by itself: another stream of the
 * same file is still open. It costs no download attempt, so it is waited out
 * like a throttle. An exhausted attempt counter is not — no wait brings the
 * attempts back. */
function isDownloadThrottled(error: PdfikError): boolean {
  return isThrottled(error) || (error.statusCode === 429 && isCase(error, 'download-busy'));
}

/** The header that makes a resent create safe: the API answers a repeated key
 * with the ORIGINAL job, so a create whose first answer was lost (a 5xx after
 * the job already existed) cannot produce — and charge — a second one. Built
 * once per call, so every resend of that call carries the same key. */
function idempotencyHeader(key?: string): Record<string, string> {
  return { 'Idempotency-Key': key || newUuid() };
}

/** A UUID v4, from whatever the runtime has. Web Crypto first (browsers, Edge,
 * Node 19+), then Node's own module (Node 18 has no global `crypto`). A browser
 * bundle gets that module stubbed out, and a page served over plain http has no
 * `randomUUID`, so the last branch builds one by hand: the key only has to
 * differ from call to call, it is not a secret. */
function newUuid(): string {
  const web = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (typeof web?.randomUUID === 'function') return web.randomUUID();
  const node = crypto as { randomUUID?: () => string } | undefined;
  if (typeof node?.randomUUID === 'function') return node.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.floor(Math.random() * 16);
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/** Milliseconds to wait after a 429: the API's `retry_after_seconds`, else its
 * `Retry-After` header in seconds (either one capped), else `fallbackMs`. */
function throttleDelayMs(error: PdfikError, fallbackMs: number, headers?: Headers): number {
  let seconds = Number(problemBody(error).retry_after_seconds);
  if (!(seconds > 0) && headers) {
    seconds = Number(headers.get('Retry-After'));
  }
  return seconds > 0 ? Math.min(seconds, RETRY_AFTER_CAP_SECONDS) * 1000 : fallbackMs;
}

/**
 * Readable text for an error body's `detail`. Request-validation errors (422)
 * carry a LIST of `{ loc, msg }` items instead of a string — assigned as-is it
 * became the message "[object Object]". They read as
 * "options.viewport.width: Input should be less than or equal to 1920".
 */
function errorDetail(detail: unknown): string | undefined {
  if (Array.isArray(detail)) {
    const parts = detail.map((item) => {
      if (item && typeof item === 'object') {
        const loc = Array.isArray(item.loc) ? item.loc.filter((x: unknown) => x !== 'body').join('.') : '';
        const msg = typeof item.msg === 'string' ? item.msg : JSON.stringify(item);
        return loc ? `${loc}: ${msg}` : msg;
      }
      return String(item);
    });
    return parts.filter(Boolean).join('; ') || undefined;
  }
  if (typeof detail === 'string' && detail) return detail;
  if (detail && typeof detail === 'object') return JSON.stringify(detail);
  return undefined;
}

export class PdfikClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(config: PdfikClientConfig) {
    if (!config.apiKey) {
      throw new Error('API key is required');
    }
    this.apiKey = config.apiKey;
    this.baseUrl = (config.baseUrl || 'https://api.pdfik.net').replace(/\/$/, '');
  }

  private async request(
    path: string,
    method: string,
    body?: any,
    extraHeaders?: Record<string, string>,
    throttled: (error: PdfikError) => boolean = isThrottled,
    // The sync (`wait: true`) calls turn this off: their 503 means the server
    // CANCELLED the job and released the Idempotency-Key, so a resend would
    // not replay — it would render, and charge, a fresh job. Throttle waits
    // (`throttled`) stay on either way; those resends are safe.
    retry5xx: boolean = true
  ): Promise<Response> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      'X-API-Key': this.apiKey,
      ...extraHeaders,
    };

    if (body) {
      headers['Content-Type'] = 'application/json';
    }

    const fetchOptions: RequestInit = {
      method,
      headers,
    };

    if (body) {
      fetchOptions.body = JSON.stringify(mapKeys(body, camelToSnake));
    }

    let attempt = 0;
    let throttleWaits = 0;
    while (true) {
      const response = await fetch(url, fetchOptions);
      if (response.ok) {
        return response;
      }
      const error = await this.errorFrom(response);
      if (throttled(error) && throttleWaits < THROTTLE_WAITS) {
        throttleWaits++;
        const delay = throttleDelayMs(error, RETRY_AFTER_FALLBACK_MS, response.headers);
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
      attempt++;
      if (!retry5xx || attempt >= MAX_ATTEMPTS || error.statusCode < 500) {
        throw error;
      }
      const delay = BACKOFF_INITIAL_MS * Math.pow(2, attempt - 1);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  private async errorFrom(response: Response): Promise<PdfikError> {
    let errorCode: string | undefined;
    let message = `API request failed with status ${response.status}`;
    let responseBody = '';
    try {
      responseBody = await response.text();
      const data = JSON.parse(responseBody);
      if (data && typeof data === 'object') {
        const detail = errorDetail(data.detail);
        if (detail) {
          message = detail;
        }
        // pdf-api's RFC 7807 bodies carry the code in `error`
        // (QUOTA_EXCEEDED, EINVOICE_XML_INVALID, …); `error_code` is kept
        // as a fallback for any body that still uses it.
        const code = data.error ?? data.error_code;
        if (typeof code === 'string' && code) {
          errorCode = code;
        }
      }
    } catch {
      // ignore JSON/text reading errors
    }
    return new PdfikError(message, response.status, errorCode, responseBody);
  }

  /**
   * POSTs a create body with `wait: true` and returns the answered file bytes.
   *
   * Throttle 429s are waited out exactly as on an async create — the resend
   * carries the same Idempotency-Key, so it attaches to the same request. Any
   * other failure is thrown after ONE attempt (`retry5xx` off): a 503 means
   * the server CANCELLED the job and released the key, so an automatic resend
   * would start — and charge — a brand-new render of a page already known to
   * be too slow, and a 422 is the render's own failure, which would only fail
   * again. Whether to retry is the caller's decision.
   */
  private async requestFile(path: string, body: any, idempotencyKey?: string): Promise<Uint8Array> {
    const res = await this.request(
      path,
      'POST',
      { ...body, wait: true },
      idempotencyHeader(idempotencyKey),
      isThrottled,
      false
    );
    // A server from before synchronous mode ignores the unknown `wait` field,
    // queues the job and answers 202 JSON. Those bytes are a job receipt, not
    // the file — returned as-is they would end up inside someone's page.pdf —
    // so the mismatch is refused, with the job id needed to poll instead.
    const contentType = res.headers?.get('content-type') || '';
    if (res.status === 202 || contentType.includes('application/json')) {
      let jobId: string | undefined;
      let responseBody: string | undefined;
      try {
        responseBody = await res.text();
        jobId = JSON.parse(responseBody)?.job_id;
      } catch {
        // an unreadable body changes nothing: the answer was not the file
      }
      throw new PdfikError(
        `the server ignored wait: true — it predates synchronous mode; poll the job instead ` +
          `(job ${jobId ?? 'unknown'}: waitForJob, then downloadPdf)`,
        res.status,
        'SYNC_MODE_UNSUPPORTED',
        responseBody
      );
    }
    return new Uint8Array(await res.arrayBuffer());
  }

  /**
   * Submits a job to convert a public URL to a PDF.
   *
   * Set `opts.test = true` to run the job in test mode: it goes through the
   * full pipeline (statuses, webhook, download) without real rendering, and
   * the download returns a sample PDF. Quotas are not debited — test jobs
   * are free and rate-limited instead (60/min, 2,000/day). Job
   * status and webhook payloads always carry `test: true|false`.
   *
   * Pass `opts.einvoice` to turn the render into a Factur-X hybrid e-invoice:
   * the rendered page becomes the visual half, the output is normalized to
   * PDF/A-3 and the XML is embedded as `factur-x.xml`. Mutually exclusive
   * with `options.userPassword` (PDF/A forbids encryption) and
   * `options.compression` (re-saving breaks the PDF/A attributes).
   *
   * Pass `opts.delivery` to upload the output straight to your own
   * bucket via a presigned PUT URL — nothing is stored on PDFik's side, the
   * download endpoint answers 404 for such jobs, and the `job.finished`
   * webhook carries neither `file_url` nor `expires_at` (PDFik does not
   * record where the file went). Not combinable with `test`.
   */
  async urlToPdf(
    url: string,
    opts?: { webhookUrl?: string; options?: PdfOptions; render?: RenderOptions; auth?: JobAuthOptions; einvoice?: EInvoiceOptions; delivery?: DeliveryOptions; idempotencyKey?: string; test?: boolean }
  ): Promise<JobCreatedResponse> {
    validateRenderOptions(opts?.render);
    const body = {
      url,
      webhookUrl: opts?.webhookUrl,
      options: opts?.options,
      render: opts?.render,
      auth: opts?.auth,
      einvoice: opts?.einvoice,
      delivery: normalizeDelivery(opts?.delivery),
      test: opts?.test,
    };
    const res = await this.request('/url-to-pdf', 'POST', body, idempotencyHeader(opts?.idempotencyKey));
    const data = await res.json();
    return mapKeys(data, snakeToCamel) as JobCreatedResponse;
  }

  /**
   * Renders a public URL and returns the PDF bytes in this one call: the body
   * carries `wait: true`, so the server holds the request (up to ~45 s, no
   * client-side timer) and answers with the file itself — no polling, no
   * download step. The served stream consumes one of the job's 3 download
   * attempts; the file also stays downloadable for the normal 24 h.
   *
   * `opts` are `urlToPdf`'s minus `delivery`: with `wait` the response IS the
   * file, so there is nothing left to deliver to your own bucket and the
   * server rejects the combination by design.
   *
   * A render too slow for the window is cancelled by the server and answered
   * with 503 `SYNC_TIMEOUT` — the job was NOT charged and its Idempotency-Key
   * was released, so retrying is safe, but it is YOUR call: the client never
   * resends it (the same page would likely time out — and this time cost —
   * again). A failed render is a 422 whose `errorCode` is the job's own
   * (`PAGE_TIMEOUT`, `PAGE_NOT_FOUND`, …).
   */
  async urlToPdfFile(
    url: string,
    opts?: { webhookUrl?: string; options?: PdfOptions; render?: RenderOptions; auth?: JobAuthOptions; einvoice?: EInvoiceOptions; idempotencyKey?: string; test?: boolean }
  ): Promise<Uint8Array> {
    validateRenderOptions(opts?.render);
    const body = {
      url,
      webhookUrl: opts?.webhookUrl,
      options: opts?.options,
      render: opts?.render,
      auth: opts?.auth,
      einvoice: opts?.einvoice,
      test: opts?.test,
    };
    return this.requestFile('/url-to-pdf', body, opts?.idempotencyKey);
  }

  /**
   * Submits a job to convert raw HTML markup to a PDF.
   *
   * Set `opts.test = true` to run the job in test mode: it goes through the
   * full pipeline (statuses, webhook, download) without real rendering, and
   * the download returns a sample PDF. Quotas are not debited — test jobs
   * are free and rate-limited instead (60/min, 2,000/day). Job
   * status and webhook payloads always carry `test: true|false`.
   *
   * Pass `opts.einvoice` to turn the render into a Factur-X hybrid e-invoice:
   * the rendered page becomes the visual half, the output is normalized to
   * PDF/A-3 and the XML is embedded as `factur-x.xml`. Mutually exclusive
   * with `options.userPassword` (PDF/A forbids encryption) and
   * `options.compression` (re-saving breaks the PDF/A attributes).
   *
   * Pass `opts.delivery` to upload the output straight to your own
   * bucket via a presigned PUT URL — nothing is stored on PDFik's side, the
   * download endpoint answers 404 for such jobs, and the `job.finished`
   * webhook carries neither `file_url` nor `expires_at` (PDFik does not
   * record where the file went). Not combinable with `test`.
   */
  async htmlToPdf(
    html: string,
    opts?: { webhookUrl?: string; options?: PdfOptions; render?: RenderOptions; einvoice?: EInvoiceOptions; delivery?: DeliveryOptions; idempotencyKey?: string; test?: boolean }
  ): Promise<JobCreatedResponse> {
    validateRenderOptions(opts?.render);
    const body = {
      html,
      webhookUrl: opts?.webhookUrl,
      options: opts?.options,
      render: opts?.render,
      einvoice: opts?.einvoice,
      delivery: normalizeDelivery(opts?.delivery),
      test: opts?.test,
    };
    const res = await this.request('/html-to-pdf', 'POST', body, idempotencyHeader(opts?.idempotencyKey));
    const data = await res.json();
    return mapKeys(data, snakeToCamel) as JobCreatedResponse;
  }

  /**
   * Renders raw HTML markup and returns the PDF bytes in this one call
   * (`wait: true`). `opts` are `htmlToPdf`'s minus `delivery`; timeout (503
   * `SYNC_TIMEOUT`, cancelled and not charged, never resent by the client)
   * and render failure (422 with the job's own `errorCode`) behave exactly as
   * on `urlToPdfFile`.
   */
  async htmlToPdfFile(
    html: string,
    opts?: { webhookUrl?: string; options?: PdfOptions; render?: RenderOptions; einvoice?: EInvoiceOptions; idempotencyKey?: string; test?: boolean }
  ): Promise<Uint8Array> {
    validateRenderOptions(opts?.render);
    const body = {
      html,
      webhookUrl: opts?.webhookUrl,
      options: opts?.options,
      render: opts?.render,
      einvoice: opts?.einvoice,
      test: opts?.test,
    };
    return this.requestFile('/html-to-pdf', body, opts?.idempotencyKey);
  }

  /**
   * Submits a job that converts Markdown (CommonMark + GFM tables and
   * strikethrough) to a PDF. Raw HTML inside the Markdown is escaped, not
   * rendered — use `htmlToPdf` for full HTML control. A built-in print
   * stylesheet is applied; `opts.options` (paper format, margins,
   * header/footer, watermark, ...) works exactly as on `htmlToPdf`.
   * Job polling and download are identical to the other PDF endpoints.
   *
   * Set `opts.test = true` for test mode (full pipeline, no real rendering,
   * sample PDF, no quota) or pass `opts.delivery` to upload the output
   * straight to your own bucket via a presigned PUT URL (not combinable with
   * `test`).
   */
  async markdownToPdf(
    markdown: string,
    opts?: { webhookUrl?: string; options?: PdfOptions; render?: RenderOptions; delivery?: DeliveryOptions; idempotencyKey?: string; test?: boolean }
  ): Promise<JobCreatedResponse> {
    validateRenderOptions(opts?.render);
    const body = {
      markdown,
      webhookUrl: opts?.webhookUrl,
      options: opts?.options,
      render: opts?.render,
      delivery: normalizeDelivery(opts?.delivery),
      test: opts?.test,
    };
    const res = await this.request('/markdown-to-pdf', 'POST', body, idempotencyHeader(opts?.idempotencyKey));
    const data = await res.json();
    return mapKeys(data, snakeToCamel) as JobCreatedResponse;
  }

  /**
   * Converts Markdown and returns the PDF bytes in this one call
   * (`wait: true`). `opts` are `markdownToPdf`'s minus `delivery`; timeout
   * (503 `SYNC_TIMEOUT`, cancelled and not charged, never resent by the
   * client) and render failure (422 with the job's own `errorCode`) behave
   * exactly as on `urlToPdfFile`.
   */
  async markdownToPdfFile(
    markdown: string,
    opts?: { webhookUrl?: string; options?: PdfOptions; render?: RenderOptions; idempotencyKey?: string; test?: boolean }
  ): Promise<Uint8Array> {
    validateRenderOptions(opts?.render);
    const body = {
      markdown,
      webhookUrl: opts?.webhookUrl,
      options: opts?.options,
      render: opts?.render,
      test: opts?.test,
    };
    return this.requestFile('/markdown-to-pdf', body, opts?.idempotencyKey);
  }

  /**
   * Submits a job that captures a public URL as an image (screenshot).
   *
   * `opts.options` controls the output: `format` 'png' (default) or 'jpeg',
   * `fullPage` (default false - the visible area only), `quality` (jpeg
   * only) and `viewport` (default 1024x768; width 320-1920, height 320-8192). Poll with `waitForJob` and fetch
   * the bytes with `downloadPdf` — for image jobs the download returns
   * `image/png` or `image/jpeg` instead of a PDF.
   *
   * `opts.auth` (Pro+) attaches basic/bearer credentials exactly as on
   * `urlToPdf`. `opts.test` and `opts.delivery` behave as on the PDF
   * endpoints (and are not combinable with each other).
   */
  async urlToImage(
    url: string,
    opts?: { webhookUrl?: string; options?: ImageOptions; render?: RenderOptions; auth?: JobAuthOptions; delivery?: DeliveryOptions; idempotencyKey?: string; test?: boolean }
  ): Promise<JobCreatedResponse> {
    validateRenderOptions(opts?.render);
    const body = {
      url,
      webhookUrl: opts?.webhookUrl,
      options: opts?.options,
      render: opts?.render,
      auth: opts?.auth,
      delivery: normalizeDelivery(opts?.delivery),
      test: opts?.test,
    };
    const res = await this.request('/url-to-image', 'POST', body, idempotencyHeader(opts?.idempotencyKey));
    const data = await res.json();
    return mapKeys(data, snakeToCamel) as JobCreatedResponse;
  }

  /**
   * Captures a public URL and returns the image bytes (PNG or JPEG, per
   * `options.format`) in this one call (`wait: true`). `opts` are
   * `urlToImage`'s minus `delivery`; timeout (503 `SYNC_TIMEOUT`, cancelled
   * and not charged, never resent by the client) and render failure (422 with
   * the job's own `errorCode`) behave exactly as on `urlToPdfFile`.
   */
  async urlToImageFile(
    url: string,
    opts?: { webhookUrl?: string; options?: ImageOptions; render?: RenderOptions; auth?: JobAuthOptions; idempotencyKey?: string; test?: boolean }
  ): Promise<Uint8Array> {
    validateRenderOptions(opts?.render);
    const body = {
      url,
      webhookUrl: opts?.webhookUrl,
      options: opts?.options,
      render: opts?.render,
      auth: opts?.auth,
      test: opts?.test,
    };
    return this.requestFile('/url-to-image', body, opts?.idempotencyKey);
  }

  /**
   * Submits a job that captures raw HTML markup as an image (screenshot).
   *
   * `opts.options` controls the output: `format` 'png' (default) or 'jpeg',
   * `fullPage` (default false - the visible area only), `quality` (jpeg
   * only) and `viewport` (default 1024x768; width 320-1920, height 320-8192). Poll with `waitForJob` and fetch
   * the bytes with `downloadPdf` — for image jobs the download returns
   * `image/png` or `image/jpeg` instead of a PDF.
   *
   * `opts.test` and `opts.delivery` behave as on the PDF endpoints (and are
   * not combinable with each other).
   */
  async htmlToImage(
    html: string,
    opts?: { webhookUrl?: string; options?: ImageOptions; render?: RenderOptions; delivery?: DeliveryOptions; idempotencyKey?: string; test?: boolean }
  ): Promise<JobCreatedResponse> {
    validateRenderOptions(opts?.render);
    const body = {
      html,
      webhookUrl: opts?.webhookUrl,
      options: opts?.options,
      render: opts?.render,
      delivery: normalizeDelivery(opts?.delivery),
      test: opts?.test,
    };
    const res = await this.request('/html-to-image', 'POST', body, idempotencyHeader(opts?.idempotencyKey));
    const data = await res.json();
    return mapKeys(data, snakeToCamel) as JobCreatedResponse;
  }

  /**
   * Captures raw HTML markup and returns the image bytes (PNG or JPEG, per
   * `options.format`) in this one call (`wait: true`). `opts` are
   * `htmlToImage`'s minus `delivery`; timeout (503 `SYNC_TIMEOUT`, cancelled
   * and not charged, never resent by the client) and render failure (422 with
   * the job's own `errorCode`) behave exactly as on `urlToPdfFile`.
   */
  async htmlToImageFile(
    html: string,
    opts?: { webhookUrl?: string; options?: ImageOptions; render?: RenderOptions; idempotencyKey?: string; test?: boolean }
  ): Promise<Uint8Array> {
    validateRenderOptions(opts?.render);
    const body = {
      html,
      webhookUrl: opts?.webhookUrl,
      options: opts?.options,
      render: opts?.render,
      test: opts?.test,
    };
    return this.requestFile('/html-to-image', body, opts?.idempotencyKey);
  }

  /**
   * Submits a Factur-X e-invoice job: builds a human-readable invoice from
   * your UN/CEFACT Cross-Industry-Invoice XML using a block template, renders
   * it to PDF/A-3 and embeds the XML as `factur-x.xml` (Factur-X / ZUGFeRD
   * hybrid). Then poll with `waitForJob` and fetch via `downloadPdf` as usual.
   *
   * The XML is validated against the official XSD of the declared `profile`
   * before any quota is spent. Schema-valid does not mean tax-compliant —
   * the invoice content is the caller's responsibility. On the Free plan the
   * generated PDF carries a PDFik.net watermark.
   *
   * `opts.templateId` (a template saved on the dashboard E-Invoice page) and
   * `opts.template` (an inline block-template definition, the same JSON the
   * dashboard editor produces) are mutually exclusive; omit both to use your
   * account's default template.
   *
   * Pass `opts.delivery` to upload the output straight to your own
   * bucket via a presigned PUT URL — nothing is stored on PDFik's side, the
   * download endpoint answers 404 for such jobs, and the `job.finished`
   * webhook carries neither `file_url` nor `expires_at` (PDFik does not
   * record where the file went). Not combinable with `test`.
   */
  async einvoiceToPdf(
    xml: string,
    opts?: { profile?: EInvoiceProfile; templateId?: string; template?: Record<string, unknown>; webhookUrl?: string; delivery?: DeliveryOptions; idempotencyKey?: string; test?: boolean }
  ): Promise<JobCreatedResponse> {
    const body = {
      xml,
      profile: opts?.profile,
      templateId: opts?.templateId,
      template: opts?.template,
      webhookUrl: opts?.webhookUrl,
      delivery: normalizeDelivery(opts?.delivery),
      test: opts?.test,
    };
    const res = await this.request('/einvoice-to-pdf', 'POST', body, idempotencyHeader(opts?.idempotencyKey));
    const data = await res.json();
    return mapKeys(data, snakeToCamel) as JobCreatedResponse;
  }

  /**
   * Builds the Factur-X e-invoice and returns the PDF/A-3 bytes in this one
   * call (`wait: true`). `opts` are `einvoiceToPdf`'s minus `delivery`;
   * timeout (503 `SYNC_TIMEOUT`, cancelled and not charged, never resent by
   * the client) and render failure (422 with the job's own `errorCode`, e.g.
   * `EINVOICE_FAILED`) behave exactly as on `urlToPdfFile`. The async 202's
   * minimum/basicwl profile note travels in the `X-PDFik-Warning` response
   * header here — a file body has no `detail` field to carry it.
   */
  async einvoiceToPdfFile(
    xml: string,
    opts?: { profile?: EInvoiceProfile; templateId?: string; template?: Record<string, unknown>; webhookUrl?: string; idempotencyKey?: string; test?: boolean }
  ): Promise<Uint8Array> {
    const body = {
      xml,
      profile: opts?.profile,
      templateId: opts?.templateId,
      template: opts?.template,
      webhookUrl: opts?.webhookUrl,
      test: opts?.test,
    };
    return this.requestFile('/einvoice-to-pdf', body, opts?.idempotencyKey);
  }

  async getJob(jobId: string): Promise<JobStatusResponse> {
    const res = await this.request(`/jobs/${jobId}`, 'GET');
    const data = await res.json();
    return mapKeys(data, snakeToCamel) as JobStatusResponse;
  }

  async waitForJob(
    jobId: string,
    opts?: { timeoutMs?: number; pollIntervalMs?: number }
  ): Promise<JobStatusResponse> {
    const timeoutMs = opts?.timeoutMs ?? 120000;
    const pollIntervalMs = opts?.pollIntervalMs ?? 2000;
    const startTime = Date.now();

    while (true) {
      let job: JobStatusResponse;
      try {
        // No waiting inside the request while polling: a 429 is thrown at once
        // and waited out below, where `timeoutMs` is checked, so the caller's
        // timeout stays in charge.
        const res = await this.request(`/jobs/${jobId}`, 'GET', undefined, undefined, () => false);
        job = mapKeys(await res.json(), snakeToCamel) as JobStatusResponse;
      } catch (error) {
        // A 429 while polling is a throttle, not a failure: on Free (10
        // requests/min) a render longer than ~20 s used to end the wait with an
        // error. Wait it out, within the same timeout; one 429 costs one wait.
        if (!(error instanceof PdfikError) || error.statusCode !== 429) throw error;
        if (Date.now() - startTime >= timeoutMs) {
          throw new PdfikError(`Job ${jobId} timed out`, 408, 'TIMEOUT');
        }
        await new Promise((resolve) => setTimeout(resolve, throttleDelayMs(error, pollIntervalMs)));
        continue;
      }
      if (job.status === 'done' || job.status === 'failed') {
        if (job.status === 'failed') {
          throw new PdfikError(
            `Job ${jobId} failed`,
            400,
            job.errorCode || 'JOB_FAILED'
          );
        }
        return job;
      }

      if (Date.now() - startTime >= timeoutMs) {
        throw new PdfikError(`Job ${jobId} timed out`, 408, 'TIMEOUT');
      }

      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }

  async getFileUrl(jobId: string): Promise<JobFileResponse> {
    const cleanBaseUrl = this.baseUrl.replace(/\/+$/, '');
    return {
      jobId,
      downloadUrl: `${cleanBaseUrl}/jobs/${jobId}/download`,
      expiresInSeconds: -1,
    };
  }

  /**
   * Downloads the finished job's output bytes. Despite the name it works for
   * every job type: PDF jobs return `application/pdf`, image jobs
   * (`urlToImage` / `htmlToImage`) return the raw `image/png` or `image/jpeg`
   * bytes. Jobs submitted with the `delivery` option have no download here —
   * the file lives in your own bucket, at the address you presigned, and this
   * endpoint answers 404.
   *
   * Only one stream of a file may be open at a time: while another one is, the
   * API answers `429` download-busy and this call waits it out (it costs no
   * download attempt). `429` download-attempts-exhausted is thrown at once.
   */
  async downloadPdf(jobId: string): Promise<Uint8Array> {
    const res = await this.request(`/jobs/${jobId}/download`, 'GET', undefined, undefined, isDownloadThrottled);
    const buffer = await res.arrayBuffer();
    return new Uint8Array(buffer);
  }

  public static verifyWebhookSignature(
    rawBody: string,
    headers: Record<string, string | string[] | undefined>,
    webhookSecret: string
  ): boolean {
    const signatureHeader = (headers['x-pdfik-signature'] || headers['X-PDFik-Signature']) as string | undefined;
    const timestampHeader = (headers['x-pdfik-timestamp'] || headers['X-PDFik-Timestamp']) as string | undefined;

    if (!signatureHeader || !timestampHeader) {
      return false;
    }

    try {
      const parts = Object.fromEntries(
        signatureHeader.split(',').map((p) => {
          const eqIdx = p.indexOf('=');
          if (eqIdx === -1) return [p, ''];
          return [p.substring(0, eqIdx).trim(), p.substring(eqIdx + 1).trim()];
        })
      );
      const timestamp = parts['t'];
      const receivedSig = parts['v1'];

      if (!timestamp || !receivedSig) {
        return false;
      }

      const now = Math.floor(Date.now() / 1000);
      if (Math.abs(now - Number(timestamp)) > 300) {
        return false;
      }

      const signedPayload = `${timestamp}.${rawBody}`;
      const expectedSig = crypto
        .createHmac('sha256', webhookSecret)
        .update(signedPayload)
        .digest('hex');

      const expectedBuffer = Buffer.from(expectedSig);
      const receivedBuffer = Buffer.from(receivedSig);
      if (expectedBuffer.length !== receivedBuffer.length) {
        return false;
      }
      return crypto.timingSafeEqual(expectedBuffer, receivedBuffer);
    } catch {
      return false;
    }
  }
}
