import { PdfikClient } from '../src/client';
import { PdfikError } from '../src/errors';

describe('PdfikClient', () => {
  let mockFetch: jest.Mock;

  beforeEach(() => {
    mockFetch = jest.fn();
    global.fetch = mockFetch as any;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('urlToPdf sends correct request', async () => {
    const client = new PdfikClient({ apiKey: 'sk_test_123' });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        job_id: 'job-123',
        status: 'queued',
        detail: 'Job queued',
      }),
    });

    const response = await client.urlToPdf('https://example.com', {
      webhookUrl: 'https://webhook.com',
      options: {
        format: 'A4',
        landscape: true,
        margin: { top: '10px' },
      },
    });

    expect(response).toEqual({
      jobId: 'job-123',
      status: 'queued',
      detail: 'Job queued',
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith('https://api.pdfik.net/url-to-pdf', {
      method: 'POST',
      headers: {
        'X-API-Key': 'sk_test_123',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        url: 'https://example.com',
        webhook_url: 'https://webhook.com',
        options: {
          format: 'A4',
          landscape: true,
          margin: { top: '10px' },
        },
      }),
    });
  });

  test('htmlToPdf sends correct request', async () => {
    const client = new PdfikClient({ apiKey: 'sk_test_123' });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        job_id: 'job-456',
        status: 'queued',
        detail: 'Job queued',
      }),
    });

    const response = await client.htmlToPdf('<h1>Hello</h1>', {
      options: { printBackground: true },
    });

    expect(response).toEqual({
      jobId: 'job-456',
      status: 'queued',
      detail: 'Job queued',
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith('https://api.pdfik.net/html-to-pdf', {
      method: 'POST',
      headers: {
        'X-API-Key': 'sk_test_123',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        html: '<h1>Hello</h1>',
        options: { print_background: true },
      }),
    });
  });

  test('waitForJob polls until done', async () => {
    const client = new PdfikClient({ apiKey: 'sk_test_123' });

    // Mock 2 queued then 1 done
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: 'queued' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: 'rendering' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: 'done', pages_count: 5 }),
      });

    const result = await client.waitForJob('job-123', { pollIntervalMs: 1 });

    expect(result).toEqual({ status: 'done', pagesCount: 5 });
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  test('waitForJob rejects on failed status', async () => {
    const client = new PdfikClient({ apiKey: 'sk_test_123' });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: 'failed', error_code: 'SSRF_BLOCKED' }),
    });

    try {
      await client.waitForJob('job-123', { pollIntervalMs: 1 });
      fail('Should have thrown');
    } catch (e: any) {
      expect(e).toBeInstanceOf(PdfikError);
      expect(e.statusCode).toBe(400);
      expect(e.errorCode).toBe('SSRF_BLOCKED');
    }
  });

  test('waitForJob throws on timeout', async () => {
    const client = new PdfikClient({ apiKey: 'sk_test_123' });
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'queued' }),
    });

    await expect(
      client.waitForJob('job-123', { timeoutMs: 5, pollIntervalMs: 2 })
    ).rejects.toThrow(/timed out/);
  });

  test('retry on 500 (3 attempts)', async () => {
    const client = new PdfikClient({ apiKey: 'sk_test_123' });
    mockFetch.mockResolvedValue({
      ok: false,
      status: 502,
      text: async () => 'Bad Gateway',
    });

    // We stub setTimeout to not block tests
    const originalTimeout = global.setTimeout;
    const mockTimeout = jest.fn((fn) => fn());
    global.setTimeout = mockTimeout as any;

    try {
      await client.getJob('job-123');
      fail('Should have failed');
    } catch (e: any) {
      expect(e).toBeInstanceOf(PdfikError);
      expect(e.statusCode).toBe(502);
      expect(mockFetch).toHaveBeenCalledTimes(3);
    } finally {
      global.setTimeout = originalTimeout;
    }
  });

  test('retry on 429 then success', async () => {
    const client = new PdfikClient({ apiKey: 'sk_test_123' });
    mockFetch
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        text: async () => JSON.stringify({ detail: 'Rate limit exceeded' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: 'done' }),
      });

    const originalTimeout = global.setTimeout;
    const mockTimeout = jest.fn((fn) => fn());
    global.setTimeout = mockTimeout as any;

    try {
      const result = await client.getJob('job-123');
      expect(result.status).toBe('done');
      expect(mockFetch).toHaveBeenCalledTimes(2);
    } finally {
      global.setTimeout = originalTimeout;
    }
  });

  test('no retry on 401', async () => {
    const client = new PdfikClient({ apiKey: 'sk_test_123' });
    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => JSON.stringify({ detail: 'Unauthorized' }),
    });

    await expect(client.getJob('job-123')).rejects.toThrow(PdfikError);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test('downloadPdf returns Uint8Array', async () => {
    const client = new PdfikClient({ apiKey: 'sk_test_123' });
    const fakeBuffer = new ArrayBuffer(8);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      arrayBuffer: async () => fakeBuffer,
    });

    const result = await client.downloadPdf('job-123');
    expect(result).toBeInstanceOf(Uint8Array);
    expect(result.length).toBe(8);
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.pdfik.net/jobs/job-123/download',
      expect.any(Object)
    );
  });

  test('verifyWebhookSignature validates signatures correctly', () => {
    const rawBody = JSON.stringify({ job_id: '123', event_type: 'job.completed' });
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const webhookSecret = 'whsec_testsecret';
    
    const crypto = require('crypto');
    const signedPayload = `${timestamp}.${rawBody}`;
    const expectedSig = crypto
      .createHmac('sha256', webhookSecret)
      .update(signedPayload)
      .digest('hex');

    const headers = {
      'x-pdfik-signature': `t=${timestamp},v1=${expectedSig}`,
      'x-pdfik-timestamp': timestamp,
    };

    const isValid = PdfikClient.verifyWebhookSignature(rawBody, headers, webhookSecret);
    expect(isValid).toBe(true);

    const isInvalid = PdfikClient.verifyWebhookSignature(rawBody, headers, 'wrong_secret');
    expect(isInvalid).toBe(false);

    const missingHeaders = PdfikClient.verifyWebhookSignature(rawBody, {}, webhookSecret);
    expect(missingHeaders).toBe(false);
  });
});
