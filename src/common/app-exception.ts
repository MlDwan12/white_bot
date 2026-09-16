import { HttpException } from '@nestjs/common';
import { DEFAULT_STATUS_FOR_CODE, ErrorCode } from './error-code.enum';

/**
 * Throw this instead of a bare HttpException whenever the failure maps to one
 * of our domain error codes (e.g. CONTEST_ALREADY_DRAWN) — the exception
 * filter reads `code`/`details` off it to build the response envelope.
 *
 * `status` defaults from the code itself (DEFAULT_STATUS_FOR_CODE) rather
 * than a fixed value, so forgetting to pass it can't silently produce a
 * response whose HTTP status doesn't match its error code.
 */
export class AppException extends HttpException {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    status: number = DEFAULT_STATUS_FOR_CODE[code],
    public readonly details?: unknown,
  ) {
    super(message, status);
  }
}
