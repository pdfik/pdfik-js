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

/**
 * Readable text for an error body's `detail`. Request-validation errors (422)
 * carry a LIST of `{ loc, msg }` items instead of a string — assigned as-is it
 * became the message "[object Object]". They read as
 * "options.viewport.width: Input should be less than or equal to 1920".
 */
/** Milliseconds to wait after a 429 while polling: the API's `retry_after_seconds`
 * (capped at 60 s so the server cannot park the caller), else `fallbackMs`. */
function throttleDelayMs(error: PdfikError, fallbackMs: number): number {
  try {
    const seconds = Number(JSON.parse(error.responseBody || '{}').retry_after_seconds);
    if (seconds > 0) return Math.min(seconds, 60) * 1000;
  } catch {
    // not JSON — fall back
  }
  return fallbackMs;
}

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
    extraHeaders?: Record<string, string>
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

    const executeCall = async () => {
      const response = await fetch(url, fetchOptions);
      if (!response.ok) {
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
        throw new PdfikError(message, response.status, errorCode, responseBody);
      }
      return response;
    };

    return this.retryWithBackoff(executeCall);
  }

  private async retryWithBackoff<T>(
    fn: () => Promise<T>,
    maxAttempts = 3,
    initialDelayMs = 1000
  ): Promise<T> {
    let attempt = 0;
    while (true) {
      try {
        return await fn();
      } catch (error) {
        attempt++;
        if (
          attempt >= maxAttempts ||
          !(error instanceof PdfikError && (error.statusCode >= 500 || error.statusCode === 429))
        ) {
          throw error;
        }
        const delay = initialDelayMs * Math.pow(2, attempt - 1);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
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
   * Pass `opts.delivery` (Pro+) to upload the output straight to your own
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
    const extraHeaders = opts?.idempotencyKey ? { 'Idempotency-Key': opts.idempotencyKey } : undefined;
    const res = await this.request('/url-to-pdf', 'POST', body, extraHeaders);
    const data = await res.json();
    return mapKeys(data, snakeToCamel) as JobCreatedResponse;
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
   * Pass `opts.delivery` (Pro+) to upload the output straight to your own
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
    const extraHeaders = opts?.idempotencyKey ? { 'Idempotency-Key': opts.idempotencyKey } : undefined;
    const res = await this.request('/html-to-pdf', 'POST', body, extraHeaders);
    const data = await res.json();
    return mapKeys(data, snakeToCamel) as JobCreatedResponse;
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
   * sample PDF, no quota) or pass `opts.delivery` (Pro+) to upload the output
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
    const extraHeaders = opts?.idempotencyKey ? { 'Idempotency-Key': opts.idempotencyKey } : undefined;
    const res = await this.request('/markdown-to-pdf', 'POST', body, extraHeaders);
    const data = await res.json();
    return mapKeys(data, snakeToCamel) as JobCreatedResponse;
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
    const extraHeaders = opts?.idempotencyKey ? { 'Idempotency-Key': opts.idempotencyKey } : undefined;
    const res = await this.request('/url-to-image', 'POST', body, extraHeaders);
    const data = await res.json();
    return mapKeys(data, snakeToCamel) as JobCreatedResponse;
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
    const extraHeaders = opts?.idempotencyKey ? { 'Idempotency-Key': opts.idempotencyKey } : undefined;
    const res = await this.request('/html-to-image', 'POST', body, extraHeaders);
    const data = await res.json();
    return mapKeys(data, snakeToCamel) as JobCreatedResponse;
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
   * Pass `opts.delivery` (Pro+) to upload the output straight to your own
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
    const extraHeaders = opts?.idempotencyKey ? { 'Idempotency-Key': opts.idempotencyKey } : undefined;
    const res = await this.request('/einvoice-to-pdf', 'POST', body, extraHeaders);
    const data = await res.json();
    return mapKeys(data, snakeToCamel) as JobCreatedResponse;
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
        job = await this.getJob(jobId);
      } catch (error) {
        // A 429 while polling is a throttle, not a failure: on Free (10
        // requests/min) a render longer than ~20 s used to end the wait with an
        // error. Wait it out, within the same timeout.
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
   */
  async downloadPdf(jobId: string): Promise<Uint8Array> {
    const res = await this.request(`/jobs/${jobId}/download`, 'GET');
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
