import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { PinoLogger } from 'nestjs-pino';
import { ApiErrorResponse } from '../api-response.interface';
import { AppException } from '../app-exception';
import { ErrorCode } from '../error-code.enum';
import { sanitizeUrl } from '../../logger/sanitize-url';
import { PANEL_PREFIX, isPanelRequest } from '../panel.constants';

/**
 * Catches every exception (Nest's own HttpException tree and anything
 * unexpected) and turns it into the ApiErrorResponse envelope. Never leaks a
 * raw stack trace to the client — full details go to the logger only.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(private readonly logger: PinoLogger) {
    this.logger.setContext(AllExceptionsFilter.name);
  }

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const { status, body } = this.buildResponse(exception);

    this.logger.error(
      {
        err: exception,
        path: sanitizeUrl(request.url),
        method: request.method,
        status,
      },
      'Unhandled request error',
    );

    if (isPanelRequest(request.path)) {
      // Человеку в браузере нужен экран, а не `{"success":false}`.
      // Неаутентифицированного отправляем на вход — это самый частый случай
      // и единственное, что он может сделать дальше.
      if (status === 401) {
        response.redirect(`${PANEL_PREFIX}/login`);
        return;
      }
      response.status(status).render('layout', {
        page: 'error',
        title: 'Ошибка',
        admin: null,
        active: '',
        csrfToken: '',
        flash: null,
        status,
        message: body.error.message,
      });
      return;
    }

    response.status(status).json(body);
  }

  private buildResponse(exception: unknown): {
    status: number;
    body: ApiErrorResponse;
  } {
    if (exception instanceof AppException) {
      return {
        status: exception.getStatus(),
        body: {
          success: false,
          error: {
            code: exception.code,
            message: exception.message,
            details: exception.details,
          },
        },
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const payload = exception.getResponse();
      const message =
        typeof payload === 'string'
          ? payload
          : ((payload as { message?: string | string[] }).message ??
            exception.message);

      return {
        status,
        body: {
          success: false,
          error: {
            code: this.codeForStatus(status),
            message: Array.isArray(message) ? message.join('; ') : message,
          },
        },
      };
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      body: {
        success: false,
        error: {
          code: ErrorCode.INTERNAL_ERROR,
          message: 'Внутренняя ошибка сервера',
        },
      },
    };
  }

  private codeForStatus(status: HttpStatus): ErrorCode {
    switch (status) {
      case HttpStatus.BAD_REQUEST:
        return ErrorCode.VALIDATION_ERROR;
      case HttpStatus.UNAUTHORIZED:
        return ErrorCode.UNAUTHORIZED;
      case HttpStatus.FORBIDDEN:
        return ErrorCode.INSUFFICIENT_PERMISSIONS;
      case HttpStatus.NOT_FOUND:
        return ErrorCode.NOT_FOUND;
      case HttpStatus.CONFLICT:
        return ErrorCode.CONCURRENT_EDIT_CONFLICT;
      default: {
        // Anything else in the 4xx range is still the client's problem
        // (e.g. 429 Too Many Requests) — only 5xx/unknown should read as
        // INTERNAL_ERROR, otherwise clients can't tell "back off and retry"
        // from "we broke".
        // Number(...) rather than a type assertion or plain comparison:
        // @typescript-eslint's no-unsafe-enum-comparison and
        // no-unnecessary-type-assertion rules disagree on `status < 500`
        // and on `(status as number) < 500` respectively — this satisfies
        // both. Not a functional no-op, a lint-rule-conflict workaround.
        const numericStatus = Number(status);
        return numericStatus < 500
          ? ErrorCode.REQUEST_ERROR
          : ErrorCode.INTERNAL_ERROR;
      }
    }
  }
}
