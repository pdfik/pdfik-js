import crypto from 'crypto';
import { PdfikError } from './errors';
import {
  JobCreatedResponse,
  JobStatusResponse,
  JobFileResponse,
  PdfOptions,
  RenderOptions,
  JobAuthOptions,
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
            if (data.detail) {
              message = data.detail;
            }
            if (data.error_code) {
              errorCode = data.error_code;
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
   */
  async urlToPdf(
    url: string,
    opts?: { webhookUrl?: string; options?: PdfOptions; render?: RenderOptions; auth?: JobAuthOptions; idempotencyKey?: string; test?: boolean }
  ): Promise<JobCreatedResponse> {
    validateRenderOptions(opts?.render);
    const body = {
      url,
      webhookUrl: opts?.webhookUrl,
      options: opts?.options,
      render: opts?.render,
      auth: opts?.auth,
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
   */
  async htmlToPdf(
    html: string,
    opts?: { webhookUrl?: string; options?: PdfOptions; render?: RenderOptions; idempotencyKey?: string; test?: boolean }
  ): Promise<JobCreatedResponse> {
    validateRenderOptions(opts?.render);
    const body = {
      html,
      webhookUrl: opts?.webhookUrl,
      options: opts?.options,
      render: opts?.render,
      test: opts?.test,
    };
    const extraHeaders = opts?.idempotencyKey ? { 'Idempotency-Key': opts.idempotencyKey } : undefined;
    const res = await this.request('/html-to-pdf', 'POST', body, extraHeaders);
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
      const job = await this.getJob(jobId);
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
