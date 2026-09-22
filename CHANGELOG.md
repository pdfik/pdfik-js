# Changelog

All notable changes to `@pdfik/client` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/).

## [0.4.0] — 2026-09-19

The screenshots + Markdown + BYOB delivery release.

### Added
- `markdownToPdf(markdown, opts?)` — calls `POST /markdown-to-pdf`. CommonMark plus GFM
  tables and strikethrough; raw HTML inside the Markdown is escaped by the API, never
  rendered (use `htmlToPdf` for full HTML control), and a built-in print stylesheet is
  applied. `opts` mirror `htmlToPdf`: `webhookUrl`, `options` (paper format, margins,
  header/footer, watermark Starter+, `userPassword`/`compression` Pro+), `render` (Pro+),
  `delivery` (Pro+), `idempotencyKey`, `test`. Available on every plan, Free included.
- `urlToImage(url, opts?)` and `htmlToImage(html, opts?)` — call `POST /url-to-image` /
  `POST /html-to-image` and produce PNG or JPEG screenshots through the same job flow.
  New `ImageOptions`: `format` (`'png'` default | `'jpeg'`; the API also accepts `'jpg'`
  as an alias), `fullPage` (server default `false` — the visible area only; `true`
  follows the real page, clipped at 8,192 px), `quality` (1–100, jpeg only — the API
  answers `422` when sent with png), `viewport` (`ImageViewport`, width 320–1920,
  height 320–8192 CSS px, server default 1024×768). `urlToImage` supports the Pro+ `auth` option like
  `urlToPdf`. `downloadPdf` returns the image bytes unchanged (`Content-Type:
  image/png` / `image/jpeg`, filename `{job_id}.png` / `.jpg`); test mode returns the
  bundled sample PNG for either format. One screenshot consumes one render unit plus its
  bytes, same quotas as PDFs.
- `delivery` option (`DeliveryOptions`: `url` — an https presigned PUT URL for your own
  bucket, optional `mode` defaulting to `'presigned_put'`; Pro+ plans) on `urlToPdf`,
  `htmlToPdf`, `einvoiceToPdf`, `markdownToPdf`, `urlToImage` and `htmlToImage`. The
  rendered output is uploaded straight to your bucket and nothing is stored on PDFik's
  side: the `job.finished` webhook reports the outcome only — no `file_url` and no
  `expires_at`, because the presigned URL is a credential and is never recorded;
  `GET /jobs/{id}/download` answers `404 #output-delivered-externally`. Presign for at
  least 15 minutes and without a Content-Type condition. Not combinable with `test`
  (`400`); on Free/Starter the API answers `402 PLAN_UPGRADE_REQUIRED` with
  `feature: "delivery"`.
- Types `ImageOptions`, `ImageViewport` and `DeliveryOptions`, exported from the package
  root.
- README: "Markdown to PDF", "Screenshots" and "Deliver to your own bucket (BYOB)"
  sections; the new methods in the API reference.
- Tests: exact request bodies for the three new methods (including `full_page`/`viewport`
  snake_case mapping) and the `delivery` object on all five creation methods.

### Changed
- Version `0.3.0` → `0.4.0` (`package.json`, `package-lock.json`).

### Fixed
- `waitForJob` waits out an HTTP 429 instead of failing: it sleeps the API's
  `retry_after_seconds` (capped at 60 s) and keeps polling within `timeoutMs`. On Free
  (10 requests/min) a render longer than ~20 s used to end the wait with an error.
- Request-validation errors (HTTP 422) now carry a readable message such as
  `options.viewport.width: Input should be less than or equal to 1920`. The API sends
  `detail` as a list for these, and `PdfikError.message` used to be `[object Object]`.
- JSDoc of `delivery` and `downloadPdf` no longer claims that the `job.finished`
  webhook's `file_url` points into your bucket: for a delivered job the webhook carries
  neither `file_url` nor `expires_at`, and PDFik keeps no record of the destination.
- README: the quick start used `require('fs')` inside an ES module (a `ReferenceError`
  at run time) and the Express webhook example tested an `event_type` field the payload
  does not have.

## [0.3.0] — 2026-09-06

The e-invoicing (Factur-X) release. Everything below is what changed in the SDK
after 0.2.2 was published, according to git.

### Added
- `einvoiceToPdf(xml, opts?)` — calls `POST /einvoice-to-pdf`. Send UN/CEFACT
  Cross-Industry Invoice XML (the Factur-X payload, UTF-8, up to 1 MB) and get the
  usual `JobCreatedResponse` back (`202`, `status: 'queued'`); the finished job is a
  PDF/A-3 with the XML embedded as `factur-x.xml` (Factur-X / ZUGFeRD), fetched with
  `waitForJob` + `downloadPdf` as for any other job. `opts`: `profile`
  (`'minimum' | 'basicwl' | 'basic' | 'en16931' | 'extended'`; omitted when unset, the
  server defaults to `en16931`), `templateId` (a template saved on the dashboard) or
  `template` (an inline block-template object — the same snake_case JSON the dashboard
  editor produces), `webhookUrl`, `idempotencyKey` (sent as the `Idempotency-Key`
  header) and `test`. `templateId` and `template` are mutually exclusive; omit both to
  use the account's default template. Available on every plan, Free included.
- `einvoice` option on `urlToPdf` / `htmlToPdf` (`EInvoiceOptions`: `xml`, optional
  `profile`, optional `format: 'factur-x'`) — wraps the caller's own page: the render
  becomes the visual half and the output is normalized to PDF/A-3 with the XML embedded.
  Not combinable with `options.userPassword` or `options.compression` (PDF/A forbids
  encryption, and re-saving breaks PDF/A attributes).
- New error responses, all surfaced as `PdfikError` and never retried:
  `422 EINVOICE_XML_INVALID` (malformed or unsafe XML, a guideline URN that does not match the declared profile, an XSD failure, or XML over 1 MB),
  `422 EINVOICE_OPTIONS_CONFLICT` (`templateId` together with `template`, or `einvoice`
  with `options.userPassword` / `options.compression`), `404 EINVOICE_TEMPLATE_NOT_FOUND` (unknown `templateId`).
- Types `EInvoiceProfile` and `EInvoiceOptions`, exported from the package root.
- `PaperFormat` now lists all 11 formats the renderer accepts: `A0`–`A6`, `Letter`,
  `Legal`, `Tabloid`, `Ledger` (new: `A0`, `A1`, `A2`, `A5`, `A6`, `Ledger`).
- README: "E-invoicing (Factur-X / ZUGFeRD)" section covering both flows and the
  e-invoicing error codes; `einvoiceToPdf` in the API reference.
- Tests: `einvoiceToPdf` request body (defaults, `templateId`, `template`, `webhookUrl`,
  `test`, the `Idempotency-Key` header), inline `template` pass-through, no retry on
  `422` with the real `error` field, and the `einvoice` option on `urlToPdf` / `htmlToPdf`.

### Fixed
- `PdfikError.errorCode` was always `undefined` for API errors: pdf-api's RFC 7807
  bodies carry the code in `error` (`QUOTA_EXCEEDED`, `PLAN_UPGRADE_REQUIRED`,
  `EINVOICE_XML_INVALID`, …) while the client read `error_code`. It now reads `error`
  first and falls back to `error_code`.

### Changed
- Request validation on the API side (no client code change, but new errors to expect):
  an unknown `options.format`, a margin that is not exactly one CSS length per side
  (shorthands such as `"10mm 5mm"`), or an `auth.type` other than `basic` / `bearer`
  (and a `basic` value without `username:password`) are rejected with
  `422 VALIDATION_ERROR` before a job is created or any quota is charged. The SDK does
  not retry `4xx`.
- `package.json`: `repository` (github.com/pdfik/pdfik-js) and `bugs.url` added so npm
  links the public mirror; README intro now describes PDFik as the asynchronous
  URL/HTML-to-PDF API.
- Version `0.2.2` → `0.3.0` (`package.json`, `package-lock.json`).

## [0.2.2] — 2026-08-07

The version on npm when this changelog was introduced (build of 2026-08-07). Earlier
changes live in git history.
