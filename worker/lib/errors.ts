export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
export const invalid = (message: string) => new ApiError(400, 'invalid_request', message);
