# @pdfik/client

> **Where this code lives:** extracted from the PDFik platform monorepo (last sync 2026-10-20).
> Releases to npm are cut from the monorepo; issues and PRs are welcome here.

Official JavaScript/TypeScript SDK for [PDFik](https://pdfik.net) — the URL/HTML-to-PDF API.

One call returns the file: pass a public URL or raw HTML and get the PDF (or screenshot) bytes back in the same response — the server answers within about 45 seconds. For batches, webhook-driven pipelines and renders longer than that, the same endpoints run asynchronously: submit, get a job id back, and receive an HMAC-signed webhook (or poll) when the file is ready. Rendering runs on sandboxed headless Chromium, so modern CSS, web fonts and JavaScript-heavy pages come out the way they look in the browser.

## Features

- **TypeScript Native**: Full auto-complete and type safety for all endpoints.
- **Dual Build**: ES Modules (ESM) and CommonJS (CJS) support.
- **Zero Runtime Dependencies**: Uses native `fetch` (Node 18+, browsers, Edge).
- **One Call, One File**: `urlToPdfFile` and the other `*File` methods send the job with `wait: true` and return the output bytes directly — no polling, no download step.
- **Auto Retry**: The asynchronous methods retry `5xx` errors with exponential backoff. A rate-limit or concurrency-limit `429` is waited out for the time the API states on every call — create, status, download and the synchronous `*File` methods — and so is a busy download (`download-busy`); quota `429`s are thrown at once, without a retry. The `*File` methods never resend after a `504 SYNC_TIMEOUT`: the job was cancelled and not charged, and the retry is yours to decide. Every create call carries an `Idempotency-Key` header — the `idempotencyKey` you pass, otherwise one generated per call and reused on every resend — so a retried create returns the original job instead of creating a second one.
- **DX Affordances**: Built-in polling logic (`waitForJob`) and binary download helpers.
- **E-invoicing**: Factur-X / ZUGFeRD hybrid PDF/A-3 output — generated from your CII XML alone (`einvoiceToPdf`) or attached to your own render (the `einvoice` option).

## Installation

```bash
npm install @pdfik/client
# or
yarn add @pdfik/client
# or
pnpm add @pdfik/client
```

## Quick Start

### One call, one PDF

```typescript
import { writeFileSync } from 'fs';
import { PdfikClient } from '@pdfik/client';

const client = new PdfikClient({
  apiKey: 'sk_live_YOUR_KEY' // Get your API key from the dashboard
});

const pdf = await client.urlToPdfFile('https://example.com');
writeFileSync('page.pdf', pdf);
```

`urlToPdfFile` — and its siblings `htmlToPdfFile`, `markdownToPdfFile`, `urlToImageFile`, `htmlToImageFile` and `einvoiceToPdfFile` — sends the job with `wait: true`: the server holds the request and answers with the file itself, within about 45 seconds (the SDK sets no timers of its own). Each takes the same options as its asynchronous sibling below, minus `delivery` — with `wait` the response is the file, so there is nothing left to deliver to your own bucket and the server rejects the combination.

Three answers are possible:

- **The file** (`Uint8Array`) — the common case; most pages render in a few seconds. The file also stays downloadable for the normal 24 hours.
- **A `PdfikError` with `errorCode: 'SYNC_TIMEOUT'`** (HTTP `503`) — the render did not finish in time. The job was cancelled and **not charged**, and its `Idempotency-Key` was released, so retrying is safe — but the SDK never resends it for you: the retry is yours to decide. (Rate-limit `429`s are still waited out automatically, as on every other call.) For renders this slow, submit without `wait` and use a webhook or polling.
- **A `PdfikError` with the render's own error code** (HTTP `422`) — e.g. `PAGE_TIMEOUT` or `PAGE_NOT_FOUND`: the same codes a failed job status would show.

```typescript
import { writeFileSync } from 'fs';
import { PdfikError } from '@pdfik/client';

try {
  const png = await client.urlToImageFile('https://example.com', {
    options: { format: 'png', fullPage: true },
  });
  writeFileSync('page.png', png);
} catch (e) {
  if (e instanceof PdfikError && e.errorCode === 'SYNC_TIMEOUT') {
    // Cancelled and not charged. Retry if you choose to — the SDK never
    // retries a sync timeout for you — or submit without wait and poll.
  } else {
    throw e;
  }
}
```

A server from before synchronous mode ignores `wait` and answers `202` with a job id; the `*File` methods detect that and throw (the message names the job id so you can poll it) instead of handing the JSON back as file bytes.

### Convert public URL to PDF (asynchronous)

For batches, webhook-driven pipelines and renders longer than 45 seconds, submit the job and fetch the result when it is ready:

```typescript
import { writeFileSync } from 'fs';
import { PdfikClient } from '@pdfik/client';

// Initialize the client
const client = new PdfikClient({
  apiKey: 'sk_live_YOUR_KEY' // Get your API key from the dashboard
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
    writeFileSync('output.pdf', pdfBytes);
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

## Markdown to PDF

`markdownToPdf` converts Markdown (CommonMark + GFM tables and strikethrough) with a built-in print stylesheet. Raw HTML inside the Markdown is escaped, not rendered — use `htmlToPdf` for full HTML control. The same `options` (paper format, margins, header/footer, watermark, ...) and job flow apply. The Markdown may be up to 100,000 characters (longer input is rejected with `422`); Markdown whose converted document is too large for the processing queue is rejected with `413` ([payload-too-large-for-queue](https://docs.pdfik.net/error-codes#payload-too-large-for-queue)) and is not charged. Example:

```typescript
const job = await client.markdownToPdf('# Report\n\n| Item | Price |\n| --- | --- |\n| Render | $0.01 |', {
  options: { format: 'A4' },
});
await client.waitForJob(job.jobId);
const pdfBytes = await client.downloadPdf(job.jobId);
```

## Screenshots

`urlToImage` / `htmlToImage` capture a page as a PNG (default) or JPEG instead of a PDF. Options: `format` (`'png' | 'jpeg'`), `fullPage` (default `false` - the visible area only; with `true` the height follows the real page and is clipped at 8,192 px, which is a ceiling and not a target, so a 2,000 px page still gives a 2,000 px image, and horizontal overflow beyond the viewport width is never captured), `quality` (1-100, JPEG only) and `viewport` (`width`/`height`; you pick the window size and we capture exactly that - nothing is scaled or fitted - `width` 320-1920, `height` 320-8192, defaults to 1024x768). Polling is identical to the PDF endpoints, and `downloadPdf` returns the raw image bytes (`image/png` or `image/jpeg`, filename `{jobId}.png`/`.jpg`):

```typescript
const job = await client.urlToImage('https://example.com', {
  options: {
    format: 'jpeg',
    quality: 80,
    fullPage: true,
    viewport: { width: 1280, height: 720 },
  },
});
await client.waitForJob(job.jobId);
const imageBytes = await client.downloadPdf(job.jobId); // JPEG bytes

const htmlShot = await client.htmlToImage('<h1>Hello</h1>'); // 1024x768 PNG
```

`urlToImage` also accepts the Pro+ `auth` option (basic/bearer), exactly as `urlToPdf`. Passing `quality` together with PNG is rejected with `422`.

## Deliver to your own bucket (BYOB)

Pass `delivery` (every plan, on every job-creating method) and the output is uploaded straight to your own bucket via a presigned PUT URL; nothing is stored on PDFik's side. The URL must be `https` on the standard port 443 (any other port is rejected with `422`); presign it for at least 15 minutes and without a Content-Type condition:

```typescript
const job = await client.urlToPdf('https://example.com', {
  delivery: { url: presignedPutUrl }, // mode: 'presigned_put' is the only mode and may be omitted
});

await client.waitForJob(job.jobId); // 'done' means the PUT to your bucket succeeded
```

Once a delivered job is done, the `job.finished` webhook reports the outcome only: it carries neither `file_url` nor `expires_at`, because PDFik keeps no copy and never records where the file went (the presigned URL is a credential, so it is used once and forgotten). You already know the destination — you signed it. `downloadPdf` answers `404` ([output-delivered-externally](https://docs.pdfik.net/error-codes#output-delivered-externally)) — the file only exists in your bucket. `delivery` cannot be combined with `test: true` (`400`).

## E-invoicing (Factur-X / ZUGFeRD)

PDFik can produce hybrid e-invoices: a normal, human-readable PDF that also embeds your UN/CEFACT Cross-Industry-Invoice (CII) XML as `factur-x.xml`, normalized to PDF/A-3. Outputs are validated with veraPDF and Mustangproject. Available on every plan;

> Schema-valid does not mean tax-compliant — the invoice content is the caller's responsibility. The `minimum` and `basicwl` profiles carry accompanying data only and are NOT a legally sufficient e-invoice in DE/FR.

### Generate the PDF from the XML (`einvoiceToPdf`)

Send just the XML; PDFik builds the human-readable invoice from a block template (design one on the dashboard E-Invoice page, or pass an inline definition):

```typescript
import { readFileSync } from 'fs';

const xml = readFileSync('invoice.xml', 'utf8'); // UN/CEFACT CII XML, UTF-8, up to 1 MB

const job = await client.einvoiceToPdf(xml, {
  profile: 'en16931',         // 'minimum' | 'basicwl' | 'basic' | 'en16931' | 'extended' (default 'en16931')
  templateId: '550e8400-...', // optional saved template; omit to use your account default
  webhookUrl: 'https://yourserver.com/webhooks/pdf',
});

await client.waitForJob(job.jobId);
const pdfBytes = await client.downloadPdf(job.jobId);
```

`templateId` and `template` (an inline block-template definition — the same JSON the dashboard editor produces) are mutually exclusive; omit both to use your account's default template. The XML is validated against the official XSD of the declared `profile` before any quota is spent, and the XML's guideline parameter must match the profile. Invoices (TypeCode 380) and credit notes (381) are supported.

### Attach the XML to your own rendering (the `einvoice` option)

If you already render the visual invoice yourself, pass `einvoice` to `urlToPdf` / `htmlToPdf` — the rendered page becomes the visual half and the output is normalized to PDF/A-3 with the XML embedded:

```typescript
const job = await client.htmlToPdf(invoiceHtml, {
  einvoice: {
    format: 'factur-x', // only value in v1 (may be omitted)
    profile: 'en16931',
    xml,
  },
});
```

The `einvoice` option is mutually exclusive with `options.userPassword` (PDF/A forbids encryption) and `options.compression` (re-saving breaks the PDF/A attributes).

### E-invoicing error codes

- `422` [einvoice-xml-invalid](https://docs.pdfik.net/error-codes#einvoice-xml-invalid) — the XML failed XSD validation or does not match the declared profile.
- `422` [einvoice-options-conflict](https://docs.pdfik.net/error-codes#einvoice-options-conflict) — `einvoice` combined with `userPassword`/`compression`, or `templateId` combined with `template`.
- `404` [einvoice-template-not-found](https://docs.pdfik.net/error-codes#einvoice-template-not-found) — unknown `templateId` for this account.
- `413` [payload-too-large-for-queue](https://docs.pdfik.net/error-codes#payload-too-large-for-queue) — the XML does not fit the job queue even compressed.
- A job that fails during rendering reports `errorCode: 'EINVOICE_FAILED'` in the job status.

## Limits, retention and error codes

- **Generated volume per month** (byte quota, counts rendered output only — downloads are free): Free 0.5 GB, Starter 10 GB, Pro 50 GB, Business 300 GB. Business plans can purchase additional +1 GB blocks from the dashboard. Exceeding the quota returns `429` ([quota-bytes-exceeded](https://docs.pdfik.net/error-codes#quota-bytes-exceeded)).
- **File size**: up to 150 MB per PDF on every plan — contact support if you need more. A larger render fails the job with `FILE_TOO_LARGE` ([file-too-large](https://docs.pdfik.net/error-codes#file-too-large)).
- **Retention**: each file is available for download for 24 hours after the job finishes; the exact deadline is the `expiresAt` field in the job status (`expires_at` in the webhook payload). After that the download returns `410` ([file-expired](https://docs.pdfik.net/error-codes#file-expired)).
- **Downloads**: at most 3 download attempts per file (counted when the stream starts); after that the API returns `429` ([download-attempts-exhausted](https://docs.pdfik.net/error-codes#download-attempts-exhausted)) — re-render the file or contact support. Only 1 download stream may be active at a time; a concurrent request returns `429` ([download-busy](https://docs.pdfik.net/error-codes#download-busy)), which does not burn an attempt — `downloadPdf` waits about 10 seconds and asks again by itself.

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
  
  // The payload has no event type: a finished job carries status 'done' (or 'failed').
  // file_url is absent for jobs delivered to your own bucket (the delivery option).
  if (event.status === 'done' && event.file_url) {
    console.log(`PDF rendered! Download URL: ${event.file_url}`);
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
- **`markdownToPdf(markdown, opts)`**: Submits a job to convert Markdown (CommonMark + GFM tables) to a PDF. Returns a `JobCreatedResponse`.
- **`urlToImage(url, opts)`**: Submits a job to capture a public URL as a PNG/JPEG screenshot. Returns a `JobCreatedResponse`.
- **`htmlToImage(html, opts)`**: Submits a job to capture raw HTML markup as a PNG/JPEG screenshot. Returns a `JobCreatedResponse`.
- **`einvoiceToPdf(xml, opts)`**: Submits a Factur-X e-invoice job — builds the human-readable invoice from your CII XML with a block template, renders to PDF/A-3 and embeds the XML as `factur-x.xml`. Returns a `JobCreatedResponse`.
- **`urlToPdfFile(url, opts)` / `htmlToPdfFile(html, opts)` / `markdownToPdfFile(markdown, opts)` / `urlToImageFile(url, opts)` / `htmlToImageFile(html, opts)` / `einvoiceToPdfFile(xml, opts)`**: Synchronous variants of the six methods above — send the same request with `wait: true` and return the output file itself as a `Uint8Array` (the PDF, or PNG/JPEG bytes for the image methods); the server holds the request for up to ~45 s. Same `opts` as the corresponding method, minus `delivery`. On timeout they throw a `PdfikError` with `errorCode: 'SYNC_TIMEOUT'` (HTTP `504` — the job was cancelled and not charged; never resent by the SDK), and a failed render throws the job's own error code (HTTP `422`).
- **`getJob(jobId)`**: Fetches the status of a specific job. Returns a `JobStatusResponse`.
- **`waitForJob(jobId, opts)`**: Helper that polls `getJob` until the job is `done` or `failed`. Throws a `PdfikError` if the job fails or times out.
  - `opts.timeoutMs` (default: `120000` ms)
  - `opts.pollIntervalMs` (default: `2000` ms)
- **`getFileUrl(jobId)`**: Returns the direct download URL for the PDF (requires the "X-API-Key" header).
- **`downloadPdf(jobId)`**: Downloads and returns the output file as a `Uint8Array` — the PDF, or for image jobs the raw PNG/JPEG bytes.
- **`verifyWebhookSignature(rawBody, headers, webhookSecret)`**: **(Static)** Verifies the webhook HMAC-SHA256 signature using the raw request body and request headers. Returns `boolean`.

## License

MIT License.
