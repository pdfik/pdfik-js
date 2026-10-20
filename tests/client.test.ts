import { PdfikClient } from '../src/client';
import { PdfikError } from '../src/errors';

describe('PdfikClient', () => {
  let mockFetch: jest.Mock;
  // The Idempotency-Key of every request, read at the moment it is sent. The
  // mock keeps the request object by reference, so a key rewritten between two
  // attempts would look identical in mock.calls afterwards.
  let sentKeys: Array<string | undefined>;

  beforeEach(() => {
    mockFetch = jest.fn();
    sentKeys = [];
    global.fetch = ((url: string, init: { headers: Record<string, string> }) => {
      sentKeys.push(init.headers['Idempotency-Key']);
      return mockFetch(url, init);
    }) as any;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // Makes every sleep return at once and records the delays that were asked for.
  const recordSleeps = (): number[] => {
    const sleeps: number[] = [];
    jest.spyOn(global, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
      sleeps.push(ms ?? 0);
      fn();
      return 0;
    }) as any);
    return sleeps;
  };

  const problem = (status: number, body: object, headers: Record<string, string> = {}) => ({
    ok: false,
    status,
    headers: new Headers(headers),
    text: async () => JSON.stringify(body),
  });

  // pdf-api's rate limiter (app/middleware/rate_limit.py) as the API answered up
  // to 2026-10-12: no `type`, the wait stated in the body and in the Retry-After
  // header. Later releases add `type`/`title`/`status`; this older body is the
  // one the client must keep recognising by `error` alone.
  const rateLimited = (seconds: number) =>
    problem(
      429,
      { error: 'RATE_LIMIT_EXCEEDED', detail: 'Too many requests. Please try again later.', retry_after_seconds: seconds },
      { 'Retry-After': String(seconds) }
    );

  const jobCreated = { ok: true, json: async () => ({ job_id: 'job-123', status: 'queued', detail: 'Job queued' }) };

  const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  // What a create call sends when the caller passed no idempotencyKey.
  const generatedKey = expect.stringMatching(UUID_V4);

  // Exact shapes of pdf-api's two download 429s (_download_problem in
  // app/api/endpoints/jobs.py). The `error` code is in the body from the API
  // release after 2026-10-12; before it the `type` is the only mark.
  const downloadBusy = (extra: object = {}) =>
    problem(
      429,
      {
        type: 'https://docs.pdfik.net/error-codes#download-busy',
        title: 'Too Many Requests - Download In Progress',
        status: 429,
        detail: 'Another download of this file is already in progress. Only one active stream per file is allowed; this rejection does not consume a download attempt.',
        ...extra,
      },
      { 'Retry-After': '10' }
    );

  const downloadAttemptsExhausted = (extra: object = {}) =>
    problem(
      429,
      {
        type: 'https://docs.pdfik.net/error-codes#download-attempts-exhausted',
        title: 'Too Many Requests - Download Attempts Exhausted',
        status: 429,
        detail: 'This file has been downloaded the maximum of 3 times. Submit a new render or contact support.',
        ...extra,
      },
      { 'Retry-After': '3600' }
    );

  const pdfBytes = new Uint8Array([37, 80, 68, 70]);
  const fileSent = { ok: true, arrayBuffer: async () => pdfBytes.buffer };

  // A sync-mode (`wait: true`) answer: the response IS the file, with the job
  // id in a header (app/core/sync_wait.py `_serve_done`).
  const syncFileSent = (contentType = 'application/pdf', jobId = 'job-sync-1') => ({
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': contentType, 'x-pdfik-job-id': jobId }),
    arrayBuffer: async () => pdfBytes.buffer,
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
        'Idempotency-Key': generatedKey,
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
        'Idempotency-Key': generatedKey,
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
        'Idempotency-Key': generatedKey,
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
        'Idempotency-Key': generatedKey,
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
        'Idempotency-Key': generatedKey,
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
        'Idempotency-Key': generatedKey,
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
        'Idempotency-Key': generatedKey,
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
        'Idempotency-Key': generatedKey,
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
        'Idempotency-Key': generatedKey,
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
        'Idempotency-Key': generatedKey,
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
      .mockResolvedValueOnce(rateLimited(3))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: 'done' }),
      });
    const sleeps = recordSleeps();

    const result = await client.getJob('job-123');
    expect(result.status).toBe('done');
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([3000]);
  });

  test('downloadPdf waits out a rate-limit 429 for the stated time', async () => {
    // Free is 10 requests/min: create + polls fill the window, and the download
    // used to fail after three attempts within three seconds.
    const client = new PdfikClient({ apiKey: 'sk_test_123' });
    const bytes = new Uint8Array([37, 80, 68, 70]);
    mockFetch
      .mockResolvedValueOnce(rateLimited(7))
      .mockResolvedValueOnce(rateLimited(3))
      .mockResolvedValueOnce({ ok: true, arrayBuffer: async () => bytes.buffer });
    const sleeps = recordSleeps();

    const result = await client.downloadPdf('job-123');

    expect(Array.from(result)).toEqual([37, 80, 68, 70]);
    expect(sleeps).toEqual([7000, 3000]);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  test('a create call waits out a rate-limit 429 and resends the same request', async () => {
    const client = new PdfikClient({ apiKey: 'sk_test_123' });
    mockFetch
      .mockResolvedValueOnce(rateLimited(4))
      .mockResolvedValueOnce(rateLimited(1))
      .mockResolvedValueOnce(jobCreated);
    const sleeps = recordSleeps();

    const job = await client.urlToPdf('https://example.com', { idempotencyKey: 'key-1' });

    expect(job.jobId).toBe('job-123');
    expect(sleeps).toEqual([4000, 1000]);
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(mockFetch.mock.calls[2]).toEqual(mockFetch.mock.calls[0]);
  });

  test('a rate-limit 429 that never clears is thrown after five waits', async () => {
    const client = new PdfikClient({ apiKey: 'sk_test_123' });
    mockFetch.mockResolvedValue(rateLimited(2));
    const sleeps = recordSleeps();

    await expect(client.downloadPdf('job-123')).rejects.toMatchObject({
      name: 'PdfikError',
      statusCode: 429,
      errorCode: 'RATE_LIMIT_EXCEEDED',
      message: 'Too many requests. Please try again later.',
    });
    expect(sleeps).toEqual([2000, 2000, 2000, 2000, 2000]);
    expect(mockFetch).toHaveBeenCalledTimes(6);
  });

  test('the concurrency-limit 429 is waited out by its Retry-After header', async () => {
    const client = new PdfikClient({ apiKey: 'sk_test_123' });
    // Exact shape of pdf-api's concurrency_limit_handler (app/main.py): the wait
    // is stated in the header only.
    mockFetch
      .mockResolvedValueOnce(
        problem(
          429,
          {
            type: 'https://docs.pdfik.net/error-codes#concurrency-limit',
            title: 'Too Many Requests - Concurrency Limit',
            status: 429,
            error: 'CONCURRENCY_LIMIT_EXCEEDED',
            detail: "You already have 2 jobs queued or rendering; plan 'free' allows 2 at a time. Poll your pending jobs and retry.",
            plan: 'free',
            limit: 2,
            in_flight: 2,
            upgrade_url: 'https://pdfik.net/dashboard/billing',
          },
          { 'Retry-After': '5' }
        )
      )
      .mockResolvedValueOnce(jobCreated);
    const sleeps = recordSleeps();

    await client.htmlToPdf('<h1>Hi</h1>');

    expect(sleeps).toEqual([5000]);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  test('a throttle with no stated time waits 10 s, and a stated time is capped at 60 s', async () => {
    const client = new PdfikClient({ apiKey: 'sk_test_123' });
    mockFetch
      .mockResolvedValueOnce(problem(429, { type: 'https://docs.pdfik.net/error-codes#rate-limit-exceeded' }))
      .mockResolvedValueOnce(problem(429, { error: 'RATE_LIMIT_EXCEEDED' }, { 'Retry-After': '3600' }))
      .mockResolvedValueOnce(jobCreated);
    const sleeps = recordSleeps();

    await client.markdownToPdf('# Hi');

    expect(sleeps).toEqual([10000, 60000]);
  });

  test.each<[string, (c: PdfikClient) => Promise<unknown>, object, string | undefined]>([
    [
      'the monthly byte quota',
      (c: PdfikClient) => c.urlToPdf('https://example.com'),
      // Exact shape of pdf-api's byte_quota_exceeded_handler (app/main.py).
      problem(429, {
        type: 'https://docs.pdfik.net/error-codes#quota-bytes-exceeded',
        title: 'Too Many Requests - Byte Quota Exceeded',
        status: 429,
        error: 'BYTE_QUOTA_EXCEEDED',
        detail: "Monthly generated-data quota of 536870912 bytes for plan 'free' exceeded (536870912 bytes used this billing window).",
        plan: 'free',
        limit: 536870912,
        used: 536870912,
        upgrade_url: 'https://pdfik.net/dashboard/billing',
      }),
      'BYTE_QUOTA_EXCEEDED',
    ],
    [
      'the test-mode cap',
      (c: PdfikClient) => c.urlToPdf('https://example.com', { test: true }),
      problem(
        429,
        {
          type: 'https://docs.pdfik.net/error-codes#test-rate-limit-exceeded',
          title: 'Too Many Requests - Test Mode Rate Limit',
          status: 429,
          error: 'TEST_RATE_LIMIT_EXCEEDED',
          detail: 'Test-mode submissions are free of quota but capped at 60 per minute per account. Retry after the window resets.',
          limit: 60,
          window: 'minute',
        },
        { 'Retry-After': '30' }
      ),
      'TEST_RATE_LIMIT_EXCEEDED',
    ],
    [
      'an exhausted download counter',
      (c: PdfikClient) => c.downloadPdf('job-123'),
      downloadAttemptsExhausted(),
      undefined,
    ],
    [
      'an exhausted download counter that states its error code',
      (c: PdfikClient) => c.downloadPdf('job-123'),
      downloadAttemptsExhausted({ error: 'DOWNLOAD_ATTEMPTS_EXHAUSTED' }),
      'DOWNLOAD_ATTEMPTS_EXHAUSTED',
    ],
    [
      'download-busy on a call that is not the download',
      (c: PdfikClient) => c.getJob('job-123'),
      downloadBusy({ error: 'DOWNLOAD_BUSY' }),
      'DOWNLOAD_BUSY',
    ],
    [
      'a 429 the API did not write',
      (c: PdfikClient) => c.getJob('job-123'),
      { ok: false, status: 429, headers: new Headers({ 'Retry-After': '1' }), text: async () => '<html>Too Many Requests</html>' },
      undefined,
    ],
  ])('no wait and no retry on a 429 for %s', async (_name, call, response, errorCode) => {
    const client = new PdfikClient({ apiKey: 'sk_test_123' });
    mockFetch.mockResolvedValue(response);
    const sleeps = recordSleeps();

    await expect(call(client)).rejects.toMatchObject({ name: 'PdfikError', statusCode: 429, errorCode });
    expect(sleeps).toEqual([]);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test('downloadPdf waits out a busy download for the stated 10 s and returns the file', async () => {
    const client = new PdfikClient({ apiKey: 'sk_test_123' });
    mockFetch
      .mockResolvedValueOnce(downloadBusy({ error: 'DOWNLOAD_BUSY' }))
      .mockResolvedValueOnce(fileSent);
    const sleeps = recordSleeps();

    const result = await client.downloadPdf('job-123');

    expect(Array.from(result)).toEqual([37, 80, 68, 70]);
    expect(sleeps).toEqual([10000]);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  test.each<[string, object]>([
    ['its type alone', downloadBusy()],
    [
      'its error code alone',
      problem(429, { error: 'DOWNLOAD_BUSY', detail: 'Another download of this file is already in progress.' }, { 'Retry-After': '10' }),
    ],
  ])('a busy download is recognised by %s', async (_name, response) => {
    const client = new PdfikClient({ apiKey: 'sk_test_123' });
    mockFetch.mockResolvedValueOnce(response).mockResolvedValueOnce(fileSent);
    const sleeps = recordSleeps();

    const result = await client.downloadPdf('job-123');

    expect(Array.from(result)).toEqual([37, 80, 68, 70]);
    expect(sleeps).toEqual([10000]);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  test('a busy download that never clears is thrown after five waits', async () => {
    const client = new PdfikClient({ apiKey: 'sk_test_123' });
    mockFetch.mockResolvedValue(downloadBusy());
    const sleeps = recordSleeps();

    await expect(client.downloadPdf('job-123')).rejects.toMatchObject({
      name: 'PdfikError',
      statusCode: 429,
      message: 'Another download of this file is already in progress. Only one active stream per file is allowed; this rejection does not consume a download attempt.',
    });
    expect(sleeps).toEqual([10000, 10000, 10000, 10000, 10000]);
    expect(mockFetch).toHaveBeenCalledTimes(6);
  });

  test('busy and rate-limit waits on one download share the five', async () => {
    const client = new PdfikClient({ apiKey: 'sk_test_123' });
    mockFetch
      .mockResolvedValueOnce(rateLimited(2))
      .mockResolvedValueOnce(downloadBusy())
      .mockResolvedValueOnce(rateLimited(2))
      .mockResolvedValueOnce(downloadBusy())
      .mockResolvedValueOnce(rateLimited(2))
      .mockResolvedValueOnce(downloadBusy({ error: 'DOWNLOAD_BUSY' }));
    const sleeps = recordSleeps();

    await expect(client.downloadPdf('job-123')).rejects.toMatchObject({ statusCode: 429, errorCode: 'DOWNLOAD_BUSY' });
    expect(sleeps).toEqual([2000, 10000, 2000, 10000, 2000]);
    expect(mockFetch).toHaveBeenCalledTimes(6);
  });

  test('a 500 followed by 200 succeeds after the usual 1 s backoff', async () => {
    const client = new PdfikClient({ apiKey: 'sk_test_123' });
    mockFetch
      .mockResolvedValueOnce(problem(500, { detail: 'Failed to create job. Please try again later.' }))
      .mockResolvedValueOnce(jobCreated);
    const sleeps = recordSleeps();

    const job = await client.urlToPdf('https://example.com');

    expect(job.jobId).toBe('job-123');
    expect(sleeps).toEqual([1000]);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  test('a throttle wait does not use up one of the three 5xx attempts', async () => {
    const client = new PdfikClient({ apiKey: 'sk_test_123' });
    mockFetch
      .mockResolvedValueOnce(problem(502, {}))
      .mockResolvedValueOnce(rateLimited(6))
      .mockResolvedValueOnce(problem(502, {}))
      .mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'done' }) });
    const sleeps = recordSleeps();

    const result = await client.getJob('job-123');

    expect(result.status).toBe('done');
    expect(sleeps).toEqual([1000, 6000, 2000]);
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });

  test('a create call without a key sends one generated key, the same on every resend after a 5xx', async () => {
    const client = new PdfikClient({ apiKey: 'sk_test_123' });
    mockFetch
      .mockResolvedValueOnce(problem(500, { detail: 'Failed to create job. Please try again later.' }))
      .mockResolvedValueOnce(problem(502, {}))
      .mockResolvedValueOnce(jobCreated);
    recordSleeps();

    await client.urlToPdf('https://example.com');

    expect(sentKeys).toHaveLength(3);
    expect(sentKeys[0]).toMatch(UUID_V4);
    expect(sentKeys).toEqual([sentKeys[0], sentKeys[0], sentKeys[0]]);
  });

  test('the generated key stays the same across a throttle wait', async () => {
    const client = new PdfikClient({ apiKey: 'sk_test_123' });
    mockFetch
      .mockResolvedValueOnce(rateLimited(4))
      .mockResolvedValueOnce(rateLimited(1))
      .mockResolvedValueOnce(jobCreated);
    const sleeps = recordSleeps();

    await client.htmlToPdf('<h1>Hi</h1>');

    expect(sleeps).toEqual([4000, 1000]);
    expect(sentKeys).toHaveLength(3);
    expect(sentKeys[0]).toMatch(UUID_V4);
    expect(sentKeys).toEqual([sentKeys[0], sentKeys[0], sentKeys[0]]);
  });

  test('two separate create calls use two different generated keys', async () => {
    const client = new PdfikClient({ apiKey: 'sk_test_123' });
    mockFetch.mockResolvedValue(jobCreated);

    await client.urlToPdf('https://example.com');
    await client.urlToPdf('https://example.com');

    expect(sentKeys).toHaveLength(2);
    expect(sentKeys[0]).toMatch(UUID_V4);
    expect(sentKeys[1]).toMatch(UUID_V4);
    expect(sentKeys[1]).not.toBe(sentKeys[0]);
  });

  test("the caller's key is sent unchanged on every attempt", async () => {
    const client = new PdfikClient({ apiKey: 'sk_test_123' });
    mockFetch
      .mockResolvedValueOnce(problem(500, {}))
      .mockResolvedValueOnce(rateLimited(3))
      .mockResolvedValueOnce(jobCreated);
    recordSleeps();

    await client.urlToImage('https://example.com', { idempotencyKey: 'order_42:shot-1.v2' });

    expect(sentKeys).toEqual(['order_42:shot-1.v2', 'order_42:shot-1.v2', 'order_42:shot-1.v2']);
  });

  test('every job-creating method sends an Idempotency-Key: generated, or the one it was given', async () => {
    const client = new PdfikClient({ apiKey: 'sk_test_123' });
    mockFetch.mockResolvedValue(jobCreated);

    const create = async (opts?: { idempotencyKey: string }) => {
      await client.urlToPdf('https://example.com', opts);
      await client.htmlToPdf('<h1>Hi</h1>', opts);
      await client.markdownToPdf('# Hi', opts);
      await client.urlToImage('https://example.com', opts);
      await client.htmlToImage('<h1>Hi</h1>', opts);
      await client.einvoiceToPdf('<rsm:CrossIndustryInvoice/>', opts);
    };
    await create();
    await create({ idempotencyKey: 'mine-1' });

    expect(sentKeys).toHaveLength(12);
    const generated = sentKeys.slice(0, 6);
    for (const key of generated) {
      expect(key).toMatch(UUID_V4);
    }
    expect(new Set(generated).size).toBe(6);
    expect(sentKeys.slice(6)).toEqual(Array(6).fill('mine-1'));
  });

  // A browser bundle has no Node `crypto` (the bundler stubs the import out) and a
  // page on plain http has no `crypto.randomUUID` either. Creating a job must
  // still work there.
  test('the generated Idempotency-Key does not need crypto.randomUUID', async () => {
    const client = new PdfikClient({ apiKey: 'sk_test_123' });
    mockFetch.mockResolvedValue(jobCreated);
    // Hide it in both places the client looks, and put both back afterwards.
    const hidden = [require('crypto'), (globalThis as any).crypto]
      .filter(Boolean)
      .map((target) => ({ target, own: Object.getOwnPropertyDescriptor(target, 'randomUUID') }));
    for (const { target } of hidden) {
      Object.defineProperty(target, 'randomUUID', { value: undefined, configurable: true, writable: true });
    }

    try {
      await client.urlToPdf('https://example.com');
      await client.htmlToPdf('<h1>Hi</h1>');
    } finally {
      for (const { target, own } of hidden) {
        if (own) Object.defineProperty(target, 'randomUUID', own);
        else delete target.randomUUID;
      }
    }

    expect(sentKeys).toHaveLength(2);
    expect(sentKeys[0]).toMatch(UUID_V4);
    expect(sentKeys[1]).toMatch(UUID_V4);
    expect(sentKeys[0]).not.toBe(sentKeys[1]);
  });

  test('status and download requests carry no Idempotency-Key', async () => {
    const client = new PdfikClient({ apiKey: 'sk_test_123' });
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'done' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'done' }) })
      .mockResolvedValueOnce(fileSent);

    await client.getJob('job-123');
    await client.waitForJob('job-123');
    await client.downloadPdf('job-123');

    expect(mockFetch.mock.calls.map((call) => call[0])).toEqual([
      'https://api.pdfik.net/jobs/job-123',
      'https://api.pdfik.net/jobs/job-123',
      'https://api.pdfik.net/jobs/job-123/download',
    ]);
    expect(sentKeys).toEqual([undefined, undefined, undefined]);
    for (const [, init] of mockFetch.mock.calls) {
      expect(init.headers).toEqual({ 'X-API-Key': 'sk_test_123' });
    }
  });

  test('waitForJob: each 429 costs one wait, also past the five the request path allows', async () => {
    const client = new PdfikClient({ apiKey: 'sk_test_123' });
    for (let i = 0; i < 7; i++) {
      mockFetch.mockResolvedValueOnce(rateLimited(2));
    }
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'done' }) });
    const sleeps = recordSleeps();

    const result = await client.waitForJob('job-123', { pollIntervalMs: 500, timeoutMs: 60000 });

    expect(result.status).toBe('done');
    expect(sleeps).toEqual([2000, 2000, 2000, 2000, 2000, 2000, 2000]);
    expect(mockFetch).toHaveBeenCalledTimes(8);
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

  test('urlToPdfFile sends wait: true with an Idempotency-Key and returns the file bytes', async () => {
    const client = new PdfikClient({ apiKey: 'sk_test_123' });
    mockFetch.mockResolvedValueOnce(syncFileSent());

    const result = await client.urlToPdfFile('https://example.com', {
      options: { format: 'A4', printBackground: true },
    });

    expect(result).toBeInstanceOf(Uint8Array);
    expect(Array.from(result)).toEqual([37, 80, 68, 70]);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.pdfik.net/url-to-pdf');
    expect(JSON.parse(init.body)).toEqual({
      url: 'https://example.com',
      options: { format: 'A4', print_background: true },
      wait: true,
    });
    expect(sentKeys).toEqual([generatedKey]);
  });

  test('a 503 sync-timeout is thrown after exactly one fetch — the job was cancelled, retrying is the caller\'s choice', async () => {
    const client = new PdfikClient({ apiKey: 'sk_test_123' });
    // Exact shape of pdf-api's _sync_timeout_response (app/core/sync_wait.py).
    // The job was cancelled, NOT charged, and the Idempotency-Key released: a
    // resend would start a fresh render of a page already known to be slow, so
    // the client must not spend the usual 5xx attempts here.
    mockFetch.mockResolvedValue(
      problem(503, {
        type: 'https://docs.pdfik.net/error-codes#sync-timeout',
        title: 'Gateway Timeout - Render Did Not Finish In Time',
        status: 503,
        error: 'SYNC_TIMEOUT',
        detail:
          'The render did not finish within 45 seconds. The job was cancelled and NOT charged, and its Idempotency-Key was released, so retrying is safe. For renders this long, submit without "wait" and use a webhook or polling instead.',
        job_id: 'job-sync-2',
      })
    );
    const sleeps = recordSleeps();

    await expect(client.urlToPdfFile('https://slow.example.com')).rejects.toMatchObject({
      name: 'PdfikError',
      statusCode: 503,
      errorCode: 'SYNC_TIMEOUT',
    });
    expect(sleeps).toEqual([]);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test('a *File call waits out a rate-limit 429 and resends the same key', async () => {
    const client = new PdfikClient({ apiKey: 'sk_test_123' });
    mockFetch.mockResolvedValueOnce(rateLimited(3)).mockResolvedValueOnce(syncFileSent());
    const sleeps = recordSleeps();

    const result = await client.urlToPdfFile('https://example.com');

    expect(Array.from(result)).toEqual([37, 80, 68, 70]);
    expect(sleeps).toEqual([3000]);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(sentKeys).toHaveLength(2);
    expect(sentKeys[0]).toMatch(UUID_V4);
    expect(sentKeys[1]).toBe(sentKeys[0]);
  });

  // A server from before sync mode ignores the unknown `wait` field and
  // answers the usual 202 JSON. That is a job receipt, not the file — handing
  // it back as bytes would write `{"job_id": …}` into someone's page.pdf.
  test.each<[string, number, Headers]>([
    // No content-type on the 202 row: the status alone must be enough.
    ['a 202, even without a content type', 202, new Headers()],
    ['a 200 whose body is JSON', 200, new Headers({ 'content-type': 'application/json; charset=utf-8' })],
  ])('an old server that ignores wait (%s) is refused with the job id to poll', async (_name, status, headers) => {
    const client = new PdfikClient({ apiKey: 'sk_test_123' });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status,
      headers,
      text: async () => JSON.stringify({ job_id: 'job-old-1', status: 'queued', detail: 'Job queued' }),
    });

    try {
      await client.markdownToPdfFile('# Hi');
      fail('Should have thrown');
    } catch (e: any) {
      expect(e).toBeInstanceOf(PdfikError);
      expect(e.statusCode).toBe(status);
      expect(e.errorCode).toBe('SYNC_MODE_UNSUPPORTED');
      expect(e.message).toContain('the server ignored wait: true');
      expect(e.message).toContain('poll the job instead');
      expect(e.message).toContain('job-old-1');
    }
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test('a 422 job-failed carries the render\'s own error code, after a single fetch', async () => {
    const client = new PdfikClient({ apiKey: 'sk_test_123' });
    // Exact shape of pdf-api's _job_failed_response (app/core/sync_wait.py).
    mockFetch.mockResolvedValue(
      problem(422, {
        type: 'https://docs.pdfik.net/error-codes#job-failed',
        title: 'Unprocessable Entity - Render Failed',
        status: 422,
        error: 'PAGE_TIMEOUT',
        detail:
          'The render failed with error code PAGE_TIMEOUT. See https://docs.pdfik.net/error-codes#job-failed for what each code means.',
        job_id: 'job-sync-3',
      })
    );
    const sleeps = recordSleeps();

    await expect(client.urlToPdfFile('https://example.com')).rejects.toMatchObject({
      name: 'PdfikError',
      statusCode: 422,
      errorCode: 'PAGE_TIMEOUT',
    });
    expect(sleeps).toEqual([]);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test('a plain 5xx on a *File call is thrown at once, unlike on the async methods', async () => {
    // A sync call cannot tell a gateway's own 5xx from one that cut a live
    // render; resending blind could render — and charge — twice, so the
    // three-attempt 5xx retry stays off for the whole call.
    const client = new PdfikClient({ apiKey: 'sk_test_123' });
    mockFetch.mockResolvedValue(problem(502, {}));
    const sleeps = recordSleeps();

    await expect(client.htmlToPdfFile('<h1>Hi</h1>')).rejects.toMatchObject({
      name: 'PdfikError',
      statusCode: 502,
    });
    expect(sleeps).toEqual([]);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  // Mirrors 'every job-creating method sends an Idempotency-Key' for the six
  // synchronous siblings; that test keeps its 12 async calls unchanged.
  test('every *File method sends wait: true, no delivery, and an Idempotency-Key: generated, or the one it was given', async () => {
    const client = new PdfikClient({ apiKey: 'sk_test_123' });
    mockFetch.mockResolvedValue(syncFileSent());

    const createAll = async (opts?: { idempotencyKey: string }) => {
      await client.urlToPdfFile('https://example.com', opts);
      await client.htmlToPdfFile('<h1>Hi</h1>', opts);
      await client.markdownToPdfFile('# Hi', opts);
      await client.urlToImageFile('https://example.com', opts);
      await client.htmlToImageFile('<h1>Hi</h1>', opts);
      await client.einvoiceToPdfFile('<rsm:CrossIndustryInvoice/>', opts);
    };
    await createAll();
    await createAll({ idempotencyKey: 'mine-sync-1' });

    expect(mockFetch).toHaveBeenCalledTimes(12);
    const endpoints = [
      'https://api.pdfik.net/url-to-pdf',
      'https://api.pdfik.net/html-to-pdf',
      'https://api.pdfik.net/markdown-to-pdf',
      'https://api.pdfik.net/url-to-image',
      'https://api.pdfik.net/html-to-image',
      'https://api.pdfik.net/einvoice-to-pdf',
    ];
    expect(mockFetch.mock.calls.map((call) => call[0])).toEqual([...endpoints, ...endpoints]);
    for (const [, init] of mockFetch.mock.calls) {
      const sent = JSON.parse(init.body);
      expect(sent.wait).toBe(true);
      expect(sent.delivery).toBeUndefined();
    }
    expect(sentKeys).toHaveLength(12);
    const generated = sentKeys.slice(0, 6);
    for (const key of generated) {
      expect(key).toMatch(UUID_V4);
    }
    expect(new Set(generated).size).toBe(6);
    expect(sentKeys.slice(6)).toEqual(Array(6).fill('mine-sync-1'));
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
