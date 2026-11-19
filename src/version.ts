// Internal (not re-exported from the package index): this package's version, sent as
// `X-PDFik-Client: sdk-js/<version>`; a test pins it to package.json.
export const SDK_VERSION = '0.8.0';

/** `X-PDFik-Client` value of every request this SDK sends. */
export const CLIENT_HEADER = `sdk-js/${SDK_VERSION}`;
