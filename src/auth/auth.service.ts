import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PinoLogger } from 'nestjs-pino';
import { AppException } from '../common/app-exception';
import { ErrorCode } from '../common/error-code.enum';
import { PrismaService } from '../prisma/prisma.service';
import { AdminUser } from '../generated/prisma/client';
import { normalizeAdminEmail } from './admin-email';
import { PasswordService } from './password.service';
import { IssuedRefresh, SessionService } from './session.service';

/** Короткий TTL access-токена: отозванная сессия перестаёт работать быстро. */
export const ACCESS_TTL_SECONDS = 15 * 60;

export interface LoggedIn {
  access: string;
  refresh: IssuedRefresh;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionService,
    private readonly jwt: JwtService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(AuthService.name);
  }

  async login(email: string, password: string): Promise<LoggedIn> {
    const admin = await this.prisma.adminUser.findUnique({
      where: { email: normalizeAdminEmail(email) },
    });

    // Пароль проверяется даже для несуществующего адреса — по времени ответа
    // иначе можно было бы перебрать, какие email заведены.
    const hash = admin?.passwordHash ?? DUMMY_HASH;
    const ok = await this.passwords.verify(hash, password);

    if (!admin || !ok || admin.disabledAt) {
      // Одна и та же формулировка на все случаи: «нет такого админа»,
      // «неверный пароль» и «отключён» — разные сообщения сдали бы список
      // аккаунтов. Отключение проверяется после пароля, чтобы и время ответа
      // не отличалось.
      throw new AppException(
        ErrorCode.UNAUTHORIZED,
        'Неверный email или пароль',
      );
    }

    const issued = await this.issueFor(admin.id);
    // Та же гонка, что у `refresh`: отключение, прошедшее за время проверки
    // пароля (argon2 — десятки миллисекунд), уже погасило сессии, а эта
    // вставлена после — она пережила бы отключение и ожила после «Включить».
    await this.revokeIfDisabled(admin.id, issued.refresh.token);
    return issued;
  }

  /** Гасит только что выданную сессию, если админа успели отключить. */
  private async revokeIfDisabled(
    adminUserId: string,
    refreshToken: string,
  ): Promise<void> {
    const admin = await this.prisma.adminUser.findUnique({
      where: { id: adminUserId },
      select: { disabledAt: true },
    });
    if (!admin || admin.disabledAt) {
      await this.sessions.revoke(refreshToken);
      throw new AppException(
        ErrorCode.UNAUTHORIZED,
        'Сессия недействительна, войдите заново',
      );
    }
  }

  async refresh(token: string): Promise<LoggedIn> {
    const result = await this.sessions.rotate(token);

    if (result.status === 'stale') {
      // Параллельное обновление: новый токен уже выдан другому запросу и
      // лежит в куках. Это **не** повод выходить — иначе вторая вкладка
      // стирала бы свежие куки, которые только что получила первая, и
      // гонка всё равно кончалась бы разлогином.
      throw new AppException(
        ErrorCode.CONCURRENT_EDIT_CONFLICT,
        'Сессия уже обновлена другим запросом, повторите',
      );
    }

    if (result.status !== 'ok') {
      throw new AppException(
        ErrorCode.UNAUTHORIZED,
        'Сессия недействительна, войдите заново',
      );
    }
    // Проверяется **после** выдачи новой сессии: отключение сначала ставит
    // `disabledAt`, потом гасит сессии, и обновление, успевшее прочитать
    // старую сессию до гашения, вставило бы новую уже после него — она
    // пережила бы отключение (и снова заработала бы после «Включить»).
    // Новая сессия вставлена позже `disabledAt`, значит здесь он уже виден.
    await this.revokeIfDisabled(result.adminUserId, result.next.token);
    return {
      access: this.signAccess(result.adminUserId),
      refresh: result.next,
    };
  }

  logout(token: string): Promise<void> {
    return this.sessions.revoke(token);
  }

  /**
   * Кто сейчас говорит. Админ перечитывается из базы на каждом запросе, а не
   * берётся из токена: удаление аккаунта, понижение роли и отзыв прав должны
   * действовать немедленно, а не через четверть часа, когда истечёт access.
   */
  async resolveAdmin(accessToken: string): Promise<AdminUser> {
    let payload: { sub?: string };
    try {
      payload = await this.jwt.verifyAsync<{ sub?: string }>(accessToken);
    } catch {
      throw new AppException(ErrorCode.UNAUTHORIZED, 'Сессия истекла');
    }

    const admin = payload.sub
      ? await this.prisma.adminUser.findUnique({ where: { id: payload.sub } })
      : null;
    // Отключённый — как несуществующий: access-токен живёт ещё до 15 минут,
    // и без этой проверки отключение действовало бы только после его
    // истечения (сессии для обновления гасятся отдельно, при отключении).
    if (!admin || admin.disabledAt) {
      throw new AppException(ErrorCode.UNAUTHORIZED, 'Сессия недействительна');
    }
    return admin;
  }

  private async issueFor(adminUserId: string): Promise<LoggedIn> {
    return {
      access: this.signAccess(adminUserId),
      refresh: await this.sessions.issue(adminUserId),
    };
  }

  private signAccess(adminUserId: string): string {
    // В токене только идентификатор. Класть туда роль и права — значит
    // получить пропуск, который противоречит базе до самого истечения.
    return this.jwt.sign(
      { sub: adminUserId },
      { expiresIn: ACCESS_TTL_SECONDS },
    );
  }
}

/**
 * Хеш несуществующего пароля. Нужен, чтобы вход по неизвестному email занимал
 * столько же времени, сколько по известному: argon2 считается десятки
 * миллисекунд, и пропуск этой работы был бы отлично заметен снаружи.
 */
const DUMMY_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHRzb21lc2FsdA$J4moa2MM0/6uf3HbY2Tf5Fux8JIflTsxRyiLNIlLo0s';
