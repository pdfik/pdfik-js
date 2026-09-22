export type PaperFormat =
  | 'A0' | 'A1' | 'A2' | 'A3' | 'A4' | 'A5' | 'A6'
  | 'Letter' | 'Legal' | 'Tabloid' | 'Ledger';
export type WaitUntilEvent = 'load' | 'domcontentloaded' | 'networkidle' | 'commit';
export type JobStatus = 'queued' | 'rendering' | 'uploading' | 'done' | 'failed';

export interface MarginOptions {
  top?: string;
  right?: string;
  bottom?: string;
  left?: string;
}

export interface WatermarkOptions {
  text: string;
  color?: string;
  fontSize?: string;
  rotationDegrees?: number;
}

export interface CompressionOptions {
  level?: number;
  imageQuality?: number;
}

export interface PdfOptions {
  format?: PaperFormat;
  landscape?: boolean;
  margin?: MarginOptions;
  printBackground?: boolean;
  displayHeaderFooter?: boolean;
  headerTemplate?: string;
  footerTemplate?: string;
  watermark?: WatermarkOptions;
  userPassword?: string;
  compression?: CompressionOptions;
  scale?: number;
}

export interface RenderOptions {
  pageLoadTimeoutMs?: number;
  waitUntil?: WaitUntilEvent;
  waitForSelector?: string;
  /** Additional delay in milliseconds to wait after load (0 to 10,000 ms) */
  waitAfterLoadMs?: number;
}

export interface JobAuthOptions {
  type: 'basic' | 'bearer';
  value: string;
}

/**
 * The browser window the page is opened in. You choose the size and the server
 * captures exactly that window — nothing is scaled or fitted.
 */
export interface ImageViewport {
  /** Viewport width in CSS pixels (320 to 1920) */
  width: number;
  /** Viewport height in CSS pixels (320 to 8192) */
  height: number;
}

export interface ImageOptions {
  /** Image format: 'png' (default) or 'jpeg' */
  format?: 'png' | 'jpeg';
  /**
   * Capture the whole scrollable page instead of just the visible area.
   * Default false: the image is exactly your viewport. With true the height
   * follows the real page and is clipped at 8192 px — a ceiling, not a target,
   * so a 2,000 px page still gives a 2,000 px image.
   */
  fullPage?: boolean;
  /** JPEG quality 1-100 (jpeg only; the server rejects quality together with png) */
  quality?: number;
  /** Browser viewport (defaults to 1024x768). Sets the image width; with fullPage=false (the default) also its height. */
  viewport?: ImageViewport;
}

export interface DeliveryOptions {
  /** Delivery mode; only 'presigned_put' exists and it is filled in when omitted */
  mode?: 'presigned_put';
  /**
   * Presigned HTTPS PUT URL for your own bucket. Presign for at least 15
   * minutes and without a Content-Type condition (the upload sends none).
   * For delivered jobs the `job.finished` webhook carries neither `file_url`
   * nor `expires_at` (PDFik does not record the destination), and the
   * download endpoint answers 404.
   */
  url: string;
}

export type EInvoiceProfile = 'minimum' | 'basicwl' | 'basic' | 'en16931' | 'extended';

export interface EInvoiceOptions {
  /** E-invoice container format. Only 'factur-x' in v1 (may be omitted). */
  format?: 'factur-x';
  /**
   * Factur-X conformance profile the XML declares (default: 'en16931').
   * 'basic', 'en16931' and 'extended' carry a complete legal invoice;
   * 'minimum' and 'basicwl' are accompanying data only and are NOT a legally
   * sufficient e-invoice in DE/FR.
   */
  profile?: EInvoiceProfile;
  /**
   * UN/CEFACT Cross-Industry-Invoice XML (the Factur-X payload), UTF-8, up to
   * 1 MB. Validated against the official XSD of the declared profile.
   */
  xml: string;
}

export interface JobCreatedResponse {
  jobId: string;
  status: JobStatus;
  detail: string;
}

export interface JobMetrics {
  fileSizeBytes?: number;
  fileSizeHuman?: string;
  pageLoadMs?: number;
  /** PDFik processing time (PDF generation, watermark, compression, encryption, upload) — excludes page load and client-requested waits */
  processingMs?: number;
  totalDurationMs?: number;
  pageCount?: number;
}

export interface JobStatusResponse {
  status: JobStatus;
  createdAt?: string;
  finishedAt?: string;
  /** ISO-8601 UTC timestamp after which the file can no longer be downloaded (finishedAt + retention window, currently 24h); null until finished */
  expiresAt?: string | null;
  pagesCount?: number;
  errorCode?: string;
  metrics?: JobMetrics;
  /** True when the job was submitted in test mode (no real rendering; download returns a sample PDF) */
  test?: boolean;
}

export interface JobFileResponse {
  jobId: string;
  downloadUrl: string;
  expiresInSeconds: number;
}
