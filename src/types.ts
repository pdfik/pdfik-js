export type PaperFormat = 'A4' | 'A3' | 'Letter' | 'Legal' | 'Tabloid';
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
