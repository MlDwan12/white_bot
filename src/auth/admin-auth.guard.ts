import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { AppException } from '../common/app-exception';
import { ErrorCode } from '../common/error-code.enum';
import type { AdminUser, Permission } from '../generated/prisma/client';
import { AuthService } from './auth.service';
import { ACCESS_COOKIE } from './auth.cookies';
import { readCookie } from './read-cookie';
import { PERMISSIONS_KEY } from './require-permissions.decorator';
import { hasAllPermissions } from './permissions';

export interface AdminRequest extends Request {
  admin: AdminUser;
}

/**
 * Вход в панель: проверяет access-куку и требуемые права.
 *
 * Две проверки объединены в один гвард намеренно. Разнеси их — и появится
 * возможность навесить проверку прав, забыв проверку входа: отказ тогда
 * случится только у того, кто уже вошёл, а аноним пройдёт насквозь.
 */
@Injectable()
export class AdminAuthGuard implements CanActivate {
  constructor(
    private readonly auth: AuthService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AdminRequest>();
    const token = readCookie(request, ACCESS_COOKIE);

    if (!token) {
      throw new AppException(ErrorCode.UNAUTHORIZED, 'Требуется вход');
    }

    // Админ перечитывается из базы: удаление аккаунта и понижение роли
    // должны действовать немедленно, а не когда истечёт access-токен.
    const admin = await this.auth.resolveAdmin(token);
    request.admin = admin;

    const required = this.reflector.getAllAndOverride<Permission[]>(
      PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (required && required.length > 0) {
      const allowed = hasAllPermissions(
        {
          id: admin.id,
          role: admin.role,
          extraPermissions: admin.extraPermissions,
        },
        required,
      );
      if (!allowed) {
        throw new AppException(
          ErrorCode.INSUFFICIENT_PERMISSIONS,
          'Недостаточно прав для этого действия',
        );
      }
    }

    return true;
  }
}
