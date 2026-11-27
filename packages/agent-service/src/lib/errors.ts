/**
 * Why the service refused a request. Transports map the code to their own
 * vocabulary in one place (HTTP: apps/api/src/platform/http-errors.ts);
 * the message is shown to the user as is.
 */
export type ServiceErrorCode = 'invalid' | 'not_found' | 'forbidden' | 'conflict';

export class ServiceError extends Error {
  constructor(
    readonly code: ServiceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ServiceError';
  }
}
