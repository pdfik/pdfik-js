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

  test('markdownToPdf sends correct request', async () => {
    const client = new PdfikClient({ apiKey: 'sk_test_123' });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        job_id: 'job-md-1',
        status: 'queued',
        detail: 'Job queued',
      }),
    });

    const response = await client.markdownToPdf('# Invoice\n\nHello **world**', {
      webhookUrl: 'https://webhook.com',
      options: { format: 'A4', printBackground: true },
    });

    expect(response).toEqual({
      jobId: 'job-md-1',
      status: 'queued',
      detail: 'Job queued',
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith('https://api.pdfik.net/markdown-to-pdf', {
      method: 'POST',
      headers: {
        'X-API-Key': 'sk_test_123',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        markdown: '# Invoice\n\nHello **world**',
        webhook_url: 'https://webhook.com',
        options: { format: 'A4', print_background: true },
      }),
    });
  });

  test('markdownToPdf sends the test flag and the Idempotency-Key header', async () => {
    const client = new PdfikClient({ apiKey: 'sk_test_123' });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        job_id: 'job-md-2',
        status: 'queued',
        detail: 'Job queued',
      }),
    });

    await client.markdownToPdf('# Hi', { test: true, idempotencyKey: 'md-key-1' });

    expect(mockFetch).toHaveBeenCalledWith('https://api.pdfik.net/markdown-to-pdf', {
      method: 'POST',
      headers: {
        'X-API-Key': 'sk_test_123',
        'Idempotency-Key': 'md-key-1',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ markdown: '# Hi', test: true }),
    });
  });

  test('urlToImage sends snake_case full_page and viewport keys', async () => {
    const client = new PdfikClient({ apiKey: 'sk_test_123' });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        job_id: 'job-img-1',
        status: 'queued',
        detail: 'Job queued',
      }),
    });

    const response = await client.urlToImage('https://example.com', {
      options: {
        format: 'jpeg',
        fullPage: false,
        quality: 80,
        viewport: { width: 1280, height: 720 },
      },
    });

    expect(response).toEqual({
      jobId: 'job-img-1',
      status: 'queued',
      detail: 'Job queued',
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith('https://api.pdfik.net/url-to-image', {
      method: 'POST',
      headers: {
        'X-API-Key': 'sk_test_123',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        url: 'https://example.com',
        options: {
          format: 'jpeg',
          full_page: false,
          quality: 80,
          viewport: { width: 1280, height: 720 },
        },
      }),
    });
  });

  test('urlToImage passes the auth block through', async () => {
    const client = new PdfikClient({ apiKey: 'sk_test_123' });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        job_id: 'job-img-2',
        status: 'queued',
        detail: 'Job queued',
      }),
    });

    await client.urlToImage('https://intranet.example.com/report', {
      auth: { type: 'bearer', value: 'tok-123' },
    });

    const sent = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(sent).toEqual({
      url: 'https://intranet.example.com/report',
      auth: { type: 'bearer', value: 'tok-123' },
    });
  });

  test('htmlToImage sends correct request', async () => {
    const client = new PdfikClient({ apiKey: 'sk_test_123' });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        job_id: 'job-img-3',
        status: 'queued',
        detail: 'Job queued',
      }),
    });

    const response = await client.htmlToImage('<h1>Hello</h1>', {
      options: { fullPage: true },
      test: true,
    });

    expect(response).toEqual({
      jobId: 'job-img-3',
      status: 'queued',
      detail: 'Job queued',
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith('https://api.pdfik.net/html-to-image', {
      method: 'POST',
      headers: {
        'X-API-Key': 'sk_test_123',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        html: '<h1>Hello</h1>',
        options: { full_page: true },
        test: true,
      }),
    });
  });

  test('delivery option is sent with an explicit presigned_put mode', async () => {
    const client = new PdfikClient({ apiKey: 'sk_test_123' });
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        job_id: 'job-byob-1',
        status: 'queued',
        detail: 'Job queued',
      }),
    });

    const presignedUrl = 'https://bucket.s3.eu-central-1.amazonaws.com/report.pdf?X-Amz-Signature=abc';
    // `mode` omitted by the caller: the client must spell it out on the wire.
    await client.urlToPdf('https://example.com', {
      delivery: { url: presignedUrl },
    });

    const rawBody = mockFetch.mock.calls[0][1].body as string;
    expect(rawBody).toContain(
      `"delivery":{"mode":"presigned_put","url":${JSON.stringify(presignedUrl)}}`
    );
    expect(JSON.parse(rawBody)).toEqual({
      url: 'https://example.com',
      delivery: { mode: 'presigned_put', url: presignedUrl },
    });
  });

  test('every job-creating method accepts delivery', async () => {
    const client = new PdfikClient({ apiKey: 'sk_test_123' });
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        job_id: 'job-byob-2',
        status: 'queued',
        detail: 'Job queued',
      }),
    });

    const delivery = { mode: 'presigned_put' as const, url: 'https://bucket.example.com/out?sig=1' };
    await client.htmlToPdf('<h1>Hi</h1>', { delivery });
    await client.markdownToPdf('# Hi', { delivery });
    await client.urlToImage('https://example.com', { delivery });
    await client.htmlToImage('<h1>Hi</h1>', { delivery });
    await client.einvoiceToPdf('<rsm:CrossIndustryInvoice/>', { delivery });

    expect(mockFetch).toHaveBeenCalledTimes(5);
    for (const call of mockFetch.mock.calls) {
      const sent = JSON.parse(call[1].body);
      expect(sent.delivery).toEqual({ mode: 'presigned_put', url: 'https://bucket.example.com/out?sig=1' });
    }
  });

  test('urlToPdf with einvoice option sends the factur-x block', async () => {
    const client = new PdfikClient({ apiKey: 'sk_test_123' });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        job_id: 'job-777',
        status: 'queued',
        detail: 'Job queued',
      }),
    });

    const response = await client.urlToPdf('https://example.com/invoice/42', {
      einvoice: {
        format: 'factur-x',
        profile: 'basic',
        xml: '<rsm:CrossIndustryInvoice/>',
      },
    });

    expect(response).toEqual({
      jobId: 'job-777',
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
        url: 'https://example.com/invoice/42',
        einvoice: {
          format: 'factur-x',
          profile: 'basic',
          xml: '<rsm:CrossIndustryInvoice/>',
        },
      }),
    });
  });

  test('einvoiceToPdf sends correct request', async () => {
    const client = new PdfikClient({ apiKey: 'sk_test_123' });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        job_id: 'job-888',
        status: 'queued',
        detail: 'Job queued',
      }),
    });

    const response = await client.einvoiceToPdf('<rsm:CrossIndustryInvoice/>', {
      profile: 'en16931',
      templateId: '550e8400-e29b-41d4-a716-446655440000',
      webhookUrl: 'https://webhook.com',
    });

    expect(response).toEqual({
      jobId: 'job-888',
      status: 'queued',
      detail: 'Job queued',
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith('https://api.pdfik.net/einvoice-to-pdf', {
      method: 'POST',
      headers: {
        'X-API-Key': 'sk_test_123',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        xml: '<rsm:CrossIndustryInvoice/>',
        profile: 'en16931',
        template_id: '550e8400-e29b-41d4-a716-446655440000',
        webhook_url: 'https://webhook.com',
      }),
    });
  });

  test('einvoiceToPdf passes an inline template through', async () => {
    const client = new PdfikClient({ apiKey: 'sk_test_123' });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        job_id: 'job-889',
        status: 'queued',
        detail: 'Job queued',
      }),
    });

    // Template JSON is snake_case by definition (the dashboard editor's
    // format), so the client's key conversion must leave it intact.
    const template = {
      version: 1,
      branding: { accent_color: '#1a2029' },
      blocks: [{ type: 'line-items', show_vat_column: true }],
    };

    await client.einvoiceToPdf('<rsm:CrossIndustryInvoice/>', { template });

    expect(mockFetch).toHaveBeenCalledWith('https://api.pdfik.net/einvoice-to-pdf', {
      method: 'POST',
      headers: {
        'X-API-Key': 'sk_test_123',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        xml: '<rsm:CrossIndustryInvoice/>',
        template,
      }),
    });
  });

  test('no retry on 422 einvoice validation error', async () => {
    const client = new PdfikClient({ apiKey: 'sk_test_123' });
    mockFetch.mockResolvedValue({
      ok: false,
      status: 422,
      text: async () =>
        JSON.stringify({
          detail: 'XML failed XSD validation for profile en16931',
          error: 'EINVOICE_XML_INVALID',
        }),
    });

    try {
      await client.einvoiceToPdf('<not-an-invoice/>');
      fail('Should have thrown');
    } catch (e: any) {
      expect(e).toBeInstanceOf(PdfikError);
      expect(e.statusCode).toBe(422);
      expect(e.errorCode).toBe('EINVOICE_XML_INVALID');
    }
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  const SAMPLE_CII_XML =
    '<?xml version="1.0" encoding="UTF-8"?><rsm:CrossIndustryInvoice/>';

  test('einvoiceToPdf omits profile when not given (server default en16931)', async () => {
    const client = new PdfikClient({ apiKey: 'sk_test_123' });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        job_id: 'job-890',
        status: 'queued',
        detail: 'Job queued',
      }),
    });

    const response = await client.einvoiceToPdf(SAMPLE_CII_XML);

    expect(response).toEqual({
      jobId: 'job-890',
      status: 'queued',
      detail: 'Job queued',
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith('https://api.pdfik.net/einvoice-to-pdf', {
      method: 'POST',
      headers: {
        'X-API-Key': 'sk_test_123',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ xml: SAMPLE_CII_XML }),
    });
    // The client injects no default: unset fields are dropped from the JSON
    // and pdf-api applies en16931 itself.
    const sent = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(Object.keys(sent)).toEqual(['xml']);
  });

  test('einvoiceToPdf sends the test flag and the Idempotency-Key header', async () => {
    const client = new PdfikClient({ apiKey: 'sk_test_123' });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        job_id: 'job-891',
        status: 'queued',
        detail: 'Job queued',
      }),
    });

    await client.einvoiceToPdf(SAMPLE_CII_XML, {
      profile: 'extended',
      test: true,
      idempotencyKey: 'einv-key-1',
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith('https://api.pdfik.net/einvoice-to-pdf', {
      method: 'POST',
      headers: {
        'X-API-Key': 'sk_test_123',
        'Idempotency-Key': 'einv-key-1',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        xml: SAMPLE_CII_XML,
        profile: 'extended',
        test: true,
      }),
    });
  });

  test('einvoiceToPdf passes templateId and template through together (server rejects the pair)', async () => {
    // There is no client-side exclusivity check: both fields land in the
    // body and pdf-api answers 422 EINVOICE_OPTIONS_CONFLICT, which is
    // surfaced as-is without a retry.
    const client = new PdfikClient({ apiKey: 'sk_test_123' });
    const rawBody = JSON.stringify({
      type: 'https://docs.pdfik.net/error-codes#einvoice-options-conflict',
      title: 'Unprocessable Entity - E-Invoice Options Conflict',
      status: 422,
      error: 'EINVOICE_OPTIONS_CONFLICT',
      detail: 'template_id and template are mutually exclusive',
    });
    mockFetch.mockResolvedValue({
      ok: false,
      status: 422,
      text: async () => rawBody,
    });

    const template = { version: 1, blocks: [{ type: 'header' }] };
    try {
      await client.einvoiceToPdf(SAMPLE_CII_XML, { templateId: 'tpl-1', template });
      fail('Should have thrown');
    } catch (e: any) {
      expect(e).toBeInstanceOf(PdfikError);
      expect(e.statusCode).toBe(422);
      expect(e.message).toBe('template_id and template are mutually exclusive');
      expect(e.responseBody).toBe(rawBody);
    }

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(sent).toEqual({
      xml: SAMPLE_CII_XML,
      template_id: 'tpl-1',
      template,
    });
  });

  test('htmlToPdf with einvoice option sends the factur-x block', async () => {
    const client = new PdfikClient({ apiKey: 'sk_test_123' });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        job_id: 'job-778',
        status: 'queued',
        detail: 'Job queued',
      }),
    });

    const response = await client.htmlToPdf('<h1>Invoice 42</h1>', {
      options: { printBackground: true },
      einvoice: { xml: SAMPLE_CII_XML },
    });

    expect(response).toEqual({
      jobId: 'job-778',
      status: 'queued',
      detail: 'Job queued',
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    // The client adds no format/profile defaults to the einvoice block;
    // pdf-api assumes factur-x / en16931 when they are absent.
    expect(mockFetch).toHaveBeenCalledWith('https://api.pdfik.net/html-to-pdf', {
      method: 'POST',
      headers: {
        'X-API-Key': 'sk_test_123',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        html: '<h1>Invoice 42</h1>',
        options: { print_background: true },
        einvoice: { xml: SAMPLE_CII_XML },
      }),
    });
  });

  test('422 EINVOICE_XML_INVALID (RFC 7807 body) maps to PdfikError with status and type preserved', async () => {
    const client = new PdfikClient({ apiKey: 'sk_test_123' });
    // Exact shape of pdf-api's einvoice_xml_invalid_handler (app/main.py).
    const rawBody = JSON.stringify({
      type: 'https://docs.pdfik.net/error-codes#einvoice-xml-invalid',
      title: 'Unprocessable Entity - Invoice XML Invalid',
      status: 422,
      error: 'EINVOICE_XML_INVALID',
      detail: 'XML failed XSD validation for profile en16931',
    });
    mockFetch.mockResolvedValue({
      ok: false,
      status: 422,
      text: async () => rawBody,
    });

    try {
      await client.einvoiceToPdf('<not-an-invoice/>');
      fail('Should have thrown');
    } catch (e: any) {
      expect(e).toBeInstanceOf(PdfikError);
      expect(e.name).toBe('PdfikError');
      expect(e.statusCode).toBe(422);
      expect(e.message).toBe('XML failed XSD validation for profile en16931');
      // The problem document (incl. the documented `type` URL and the
      // `error` code) is kept verbatim on the error.
      expect(e.responseBody).toBe(rawBody);
      const problem = JSON.parse(e.responseBody);
      expect(problem.type).toBe('https://docs.pdfik.net/error-codes#einvoice-xml-invalid');
      expect(problem.error).toBe('EINVOICE_XML_INVALID');
    }
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test('422 validation error: detail list becomes a readable message, not [object Object]', async () => {
    const client = new PdfikClient({ apiKey: 'sk_test_123' });
    mockFetch.mockResolvedValue({
      ok: false,
      status: 422,
      text: async () => JSON.stringify({
        type: 'https://docs.pdfik.net/error-codes#validation-error',
        title: 'Unprocessable Entity - Request Validation Error',
        status: 422,
        detail: [{ loc: ['body', 'options', 'viewport', 'width'], msg: 'Input should be less than or equal to 1920', type: 'less_than_equal' }],
      }),
    });
    await expect(client.urlToImage('https://example.com')).rejects.toMatchObject({
      statusCode: 422,
      message: 'options.viewport.width: Input should be less than or equal to 1920',
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

  test('waitForJob waits out a 429 instead of failing', async () => {
    // Free is 10 requests/min: a render longer than ~20 s used to end the wait
    // with a 429 once the request-level retries (3) were spent.
    const client = new PdfikClient({ apiKey: 'sk_test_123' });
    const throttled = {
      ok: false,
      status: 429,
      text: async () => JSON.stringify({ error: 'RATE_LIMIT_EXCEEDED', detail: 'Too many requests. Please try again later.', retry_after_seconds: 0.01 }),
    };
    mockFetch
      .mockResolvedValueOnce(throttled)
      .mockResolvedValueOnce(throttled)
      .mockResolvedValueOnce(throttled)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'done' }) });

    const result = await client.waitForJob('job-123', { pollIntervalMs: 1, timeoutMs: 60000 });
    expect(result.status).toBe('done');
    expect(mockFetch).toHaveBeenCalledTimes(4);
  }, 15000);

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
