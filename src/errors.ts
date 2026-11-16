export class PdfikError extends Error {
  /** For a NETWORK_ERROR: the runtime's own error (`TypeError: fetch failed`, with
   * Node's reason such as ECONNREFUSED on its own `cause`; a timeout's
   * TimeoutError/AbortError; the error a body read broke off with). Undefined for
   * errors that are HTTP answers. Declared only for typing: nothing is emitted. */
  declare cause?: unknown;

  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly errorCode?: string,
    public readonly responseBody?: string,
  ) {
    super(message);
    this.name = 'PdfikError';
    Object.setPrototypeOf(this, PdfikError.prototype);
  }
}
