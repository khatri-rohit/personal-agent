import type {
  ErrorRequestHandler,
  Request,
  RequestHandler,
  Response,
} from 'express';
import { ServiceError, type ServiceErrorCode } from '@agent/agent-service';

/**
 * Express 4 ignores a rejected handler promise, so the request hangs until the
 * client gives up. Every async route goes through this so a throw reaches
 * `errorHandler` instead.
 */
export function asyncRoute(
  handler: (req: Request, res: Response) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    handler(req, res).catch(next);
  };
}

/** The one place a service refusal becomes an HTTP status. */
const SERVICE_ERROR_STATUS: Record<ServiceErrorCode, number> = {
  invalid: 400,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
};

/**
 * Last middleware: answer JSON `{ error }` with the error's status. A
 * `ServiceError` is an expected refusal (its code picks the status, logged
 * as info); anything else is logged as an error (500 unless it has a status).
 */
export const errorHandler: ErrorRequestHandler = (error, req, res, next) => {
  if (error instanceof ServiceError) {
    const status = SERVICE_ERROR_STATUS[error.code];
    req.log.info({ code: error.code, status }, 'request refused');
    if (res.headersSent) {
      next(error);
      return;
    }
    res.status(status).json({ error: error.message });
    return;
  }
  const status =
    typeof error?.status === 'number' && error.status >= 400 ? error.status : 500;
  req.log.error({ err: error, status }, 'request failed');
  // A response already under way (e.g. a stream): Express closes it.
  if (res.headersSent) {
    next(error);
    return;
  }
  res.status(status).json({
    error: error instanceof Error ? error.message : 'Internal server error',
  });
};
