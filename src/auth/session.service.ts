import { Injectable } from '@nestjs/common';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Refresh-токен — случайная строка, а не JWT: его всё равно проверяют по базе
 * (иначе нечем отзывать), так что подпись ничего не добавила бы, зато
 * позволила бы забыть про сверку и принять отозванный токен.
 */
const REFRESH_BYTES = 32;

/** Сколько живёт сессия без обновления. */
const REFRESH_TTL_DAYS = 30;

/**
 * Окно, в котором только что погашенный токен ещё не считается краденым.
 *
 * Панель легко шлёт два обновления подряд: несколько запросов разом упёрлись
 * в истёкший access, или ответ потерялся и клиент повторил. Без поблажки
 * второе обновление объявлялось бы кражей и выкидывало админа со всех
 * устройств за то, что он просто перезагрузил страницу.
 */
const REUSE_GRACE_MS = 10_000;

export interface IssuedRefresh {
  /** То, что уходит в куку. В базе лежит только хеш. */
  token: string;
  expiresAt: Date;
}

export type RefreshResult =
  | { status: 'ok'; adminUserId: string; next: IssuedRefresh }
  | { status: 'invalid' }
  /** Токен только что обменял кто-то ещё: гонка вкладок, а не кража. */
  | { status: 'stale' }
  | { status: 'reused'; adminUserId: string };

@Injectable()
export class SessionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(SessionService.name);
  }

  async issue(adminUserId: string): Promise<IssuedRefresh> {
    const token = randomBytes(REFRESH_BYTES).toString('base64url');
    const expiresAt = new Date(
      Date.now() + REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000,
    );

    await this.prisma.adminSession.create({
      // Хранится хеш: утечка дампа базы не должна превращаться в набор
      // готовых пропусков. Соль не нужна — токен и так случайный и длинный,
      // перебирать нечего.
      data: { adminUserId, refreshTokenHash: hashToken(token), expiresAt },
    });

    return { token, expiresAt };
  }

  /**
   * Обменивает refresh на новый, гася старый.
   *
   * Ротация нужна, чтобы украденная кука не работала бесконечно. А попытка
   * воспользоваться **уже погашенным** токеном — это почти наверняка кража:
   * либо вор пришёл после законного владельца, либо наоборот. Отличить, кто
   * из двоих настоящий, нельзя, поэтому отзываются все сессии админа: пусть
   * лучше он войдёт заново, чем чужой останется внутри.
   */
  async rotate(token: string): Promise<RefreshResult> {
    const session = await this.prisma.adminSession.findUnique({
      where: { refreshTokenHash: hashToken(token) },
    });

    if (!session) {
      return { status: 'invalid' };
    }

    if (session.revoked) {
      // `revokedAt` пуст у сессий, погашенных до появления этой колонки —
      // такие считаем давними, то есть краденым предъявлением.
      const sinceRevoked = session.revokedAt
        ? Date.now() - session.revokedAt.getTime()
        : Number.POSITIVE_INFINITY;
      if (sinceRevoked <= REUSE_GRACE_MS) {
        // Почти наверняка вторая вкладка или повтор после потерянного
        // ответа. Новый токен не выдаём — он уже выдан первому запросу.
        this.logger.info(
          { adminUserId: session.adminUserId },
          'Повторное обновление сессии в пределах поблажки — не считаем кражей',
        );
        return { status: 'stale' };
      }
      this.logger.warn(
        { adminUserId: session.adminUserId, sessionId: session.id },
        'Повторное использование погашенного refresh-токена — все сессии отозваны',
      );
      await this.revokeAll(session.adminUserId);
      return { status: 'reused', adminUserId: session.adminUserId };
    }

    if (session.expiresAt.getTime() <= Date.now()) {
      return { status: 'invalid' };
    }

    // Гашение и выдача — одной транзакцией: иначе при сбое посередине
    // человек остался бы без рабочего токена вовсе.
    const next = await this.prisma.$transaction(async (tx) => {
      // Гасим условием `revoked: false`, а не по id: между чтением выше и
      // этой строкой параллельный запрос мог погасить тот же токен, и без
      // условия оба обновления выдали бы по новой сессии — один токен
      // превратился бы в два живых, чего вся схема как раз не допускает.
      const burned = await tx.adminSession.updateMany({
        where: { id: session.id, revoked: false },
        data: { revoked: true, revokedAt: new Date() },
      });
      if (burned.count !== 1) {
        return null;
      }

      const fresh = randomBytes(REFRESH_BYTES).toString('base64url');
      const expiresAt = new Date(
        Date.now() + REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000,
      );
      await tx.adminSession.create({
        data: {
          adminUserId: session.adminUserId,
          refreshTokenHash: hashToken(fresh),
          expiresAt,
        },
      });
      return { token: fresh, expiresAt };
    });

    if (!next) {
      return { status: 'stale' };
    }

    return { status: 'ok', adminUserId: session.adminUserId, next };
  }

  /** Выход: гасится только эта сессия, другие устройства продолжают работать. */
  async revoke(token: string): Promise<void> {
    await this.prisma.adminSession.updateMany({
      where: { refreshTokenHash: hashToken(token), revoked: false },
      data: { revoked: true, revokedAt: new Date() },
    });
  }

  /**
   * Отзыв всех сессий админа. Зовётся при смене пароля, понижении роли и
   * удалении аккаунта: иначе сброс пароля был бы косметикой — тот, кто уже
   * внутри, так и остался бы внутри.
   */
  async revokeAll(adminUserId: string): Promise<void> {
    await this.prisma.adminSession.updateMany({
      where: { adminUserId, revoked: false },
      data: { revoked: true, revokedAt: new Date() },
    });
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Сравнение строк без утечки через время — для CSRF-токена. */
export function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}
