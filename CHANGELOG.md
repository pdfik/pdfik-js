# Changelog

All notable changes to `@pdfik/client` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/).

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
