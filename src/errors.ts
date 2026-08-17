export class PdfikError extends Error {
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
