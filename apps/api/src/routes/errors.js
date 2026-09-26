export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function unwrapApiError(error) {
  for (let current = error; current; current = current.cause) {
    if (current instanceof ApiError) return current;
  }
  return null;
}
