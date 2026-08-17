# @pdfik/client

> **Where this code lives:** extracted from the PDFik platform monorepo (last sync 2026-08-17).
> Releases to npm are cut from the monorepo; issues and PRs are welcome here.

Official JavaScript/TypeScript SDK for [PDFik](https://pdfik.net) — the asynchronous URL/HTML-to-PDF API.

Submit a public URL or raw HTML, get a job id back, and receive an HMAC-signed webhook (or poll) when the PDF is ready. Rendering runs on sandboxed headless Chromium, so modern CSS, web fonts and JavaScript-heavy pages come out the way they look in the browser.

## Features

- **TypeScript Native**: Full auto-complete and type safety for all endpoints.
- **Dual Build**: ES Modules (ESM) and CommonJS (CJS) support.
- **Zero Runtime Dependencies**: Uses native `fetch` (Node 18+, browsers, Edge).
- **Auto Retry**: Automatic exponential backoff for `5xx` and `429` (Rate Limit) errors.
- **DX Affordances**: Built-in polling logic (`waitForJob`) and binary download helpers.

## Installation

```bash
npm install @pdfik/client
# or
yarn add @pdfik/client
# or
pnpm add @pdfik/client
```

## Quick Start

### Convert public URL to PDF

```typescript
import { PdfikClient } from '@pdfik/client';

// Initialize the client
const client = new PdfikClient({
  apiKey: 'sk_live_...' // Get your API key from the dashboard
});

async function generatePdf() {
  try {
    // 1. Submit the URL to be rendered
    const job = await client.urlToPdf('https://example.com', {
      options: {
        format: 'A4',
        landscape: false,
        printBackground: true,
        margin: { top: '10mm', right: '10mm', bottom: '10mm', left: '10mm' }
      }
    });

    console.log(`Job created: ${job.jobId}. Waiting for rendering...`);

    // 2. Poll until the job completes
    const result = await client.waitForJob(job.jobId);
    console.log(`Job finished! Pages: ${result.pagesCount}`);

    // 3. Download the PDF bytes
    const pdfBytes = await client.downloadPdf(job.jobId);
    
    // Save to file (Node.js example)
    const fs = require('fs');
    fs.writeFileSync('output.pdf', pdfBytes);
    console.log('PDF saved to output.pdf');

  } catch (error) {
    console.error('Failed to generate PDF:', error);
  }
}

generatePdf();
```

### Convert raw HTML to PDF

```typescript
const job = await client.htmlToPdf('<h1>Hello World</h1><p>Sent from PDFik SDK</p>', {
  options: {
    format: 'Letter',
    displayHeaderFooter: true,
    headerTemplate: "<span style='font-size: 10px;'>My Invoice Header</span>",
    footerTemplate: "<span style='font-size: 10px;'>Page <span class='pageNumber'></span></span>"
  }
});
```

### Get the direct download URL

Get the direct API download URL for the generated PDF (requires the "X-API-Key" header to download):

```typescript
const { downloadUrl } = await client.getFileUrl(job.jobId);
console.log(`Direct Download URL: ${downloadUrl}`);
```

### Test mode

Pass `test: true` to run a job through the full pipeline (statuses, webhook, download) without real rendering — the download returns a small sample PDF. Test jobs are free (no PDF or byte quota is debited) and rate-limited instead: 60 test calls per minute and 2,000 per day per account. Job status and webhook payloads always carry `test: true|false`, so you can safely exercise your integration end to end:

```typescript
const job = await client.urlToPdf('https://example.com', { test: true });
const result = await client.waitForJob(job.jobId);
console.log(result.test);      // true
console.log(result.expiresAt); // e.g. "2026-08-05T12:00:00Z"

const pdfBytes = await client.downloadPdf(job.jobId); // sample PDF
```

## Limits, retention and error codes

- **Generated volume per month** (byte quota, counts rendered output only — downloads are free): Free 0.5 GB, Starter 10 GB, Pro 50 GB, Business 300 GB. Business plans can purchase additional +1 GB blocks from the dashboard. Exceeding the quota returns `429` ([quota-bytes-exceeded](https://docs.pdfik.net/error-codes#quota-bytes-exceeded)).
- **File size**: up to 150 MB per PDF on every plan — contact support if you need more. A larger render fails the job with `FILE_TOO_LARGE` ([file-too-large](https://docs.pdfik.net/error-codes#file-too-large)).
- **Retention**: each file is available for download for 24 hours after the job finishes; the exact deadline is the `expiresAt` field in the job status (`expires_at` in the webhook payload). After that the download returns `410` ([file-expired](https://docs.pdfik.net/error-codes#file-expired)).
- **Downloads**: at most 3 download attempts per file (counted when the stream starts); after that the API returns `429` ([download-attempts-exhausted](https://docs.pdfik.net/error-codes#download-attempts-exhausted)) — re-render the file or contact support. Only 1 download stream may be active at a time; a concurrent request returns `429` ([download-busy](https://docs.pdfik.net/error-codes#download-busy)) — wait ~10 seconds and retry, it does not burn an attempt.

### Handling Webhooks

If you specify `webhookUrl` in the options of `urlToPdf` or `htmlToPdf`, PDFik will send an HTTP `POST` request to your server when the rendering job is finished.

You should verify the authenticity of the webhook by validating the signature. We provide a static helper `verifyWebhookSignature` in `PdfikClient` for this purpose.

During a secret rotation both the new and the previous secret verify for the overlap
window you pick in the dashboard (1 hour to 5 days, or none at all), so check the new
one first and fall back to the old one while you roll your receivers out.

Custom delivery headers (e.g. a Cloudflare Access service token) are configured once on
the dashboard Webhooks page and attached to every delivery — nothing to pass per request.

#### Example (Express / Node.js):

```typescript
import express from 'express';
import { PdfikClient } from '@pdfik/client';

const app = express();

// IMPORTANT: Use raw body parser to get the exact raw bytes for verification
app.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  const webhookSecret = process.env.PDFIK_WEBHOOK_SECRET || 'whsec_...';
  const rawBody = req.body.toString('utf8');
  
  // Pass req.headers directly (contains X-PDFik-Signature and X-PDFik-Timestamp)
  const isValid = PdfikClient.verifyWebhookSignature(rawBody, req.headers as any, webhookSecret);
  
  if (!isValid) {
    console.error('Invalid webhook signature!');
    return res.status(400).send('Invalid signature');
  }
  
  const event = JSON.parse(rawBody);
  console.log(`Webhook received for job: ${event.job_id}, status: ${event.status}`);
  
  if (event.event_type === 'job.completed') {
    console.log(`PDF rendered! Download URL: https://api.pdfik.net/jobs/${event.job_id}/download`);
  }
  
  res.status(200).send('OK');
});

app.listen(3000, () => console.log('Webhook server running on port 3000'));
```

## API Reference

### `PdfikClient`

```typescript
constructor(config: { apiKey: string; baseUrl?: string })
```

#### Methods

- **`urlToPdf(url, opts)`**: Submits a job to convert a public URL to a PDF. Returns a `JobCreatedResponse`.
- **`htmlToPdf(html, opts)`**: Submits a job to convert raw HTML markup to a PDF. Returns a `JobCreatedResponse`.
- **`getJob(jobId)`**: Fetches the status of a specific job. Returns a `JobStatusResponse`.
- **`waitForJob(jobId, opts)`**: Helper that polls `getJob` until the job is `done` or `failed`. Throws a `PdfikError` if the job fails or times out.
  - `opts.timeoutMs` (default: `120000` ms)
  - `opts.pollIntervalMs` (default: `2000` ms)
- **`getFileUrl(jobId)`**: Returns the direct download URL for the PDF (requires the "X-API-Key" header).
- **`downloadPdf(jobId)`**: Downloads and returns the PDF file as a `Uint8Array`.
- **`verifyWebhookSignature(rawBody, headers, webhookSecret)`**: **(Static)** Verifies the webhook HMAC-SHA256 signature using the raw request body and request headers. Returns `boolean`.

## License

MIT License.
