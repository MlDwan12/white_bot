import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Platform, Prisma } from '../generated/prisma/client';

/** Профиль, как его отдала платформа в момент взаимодействия. */
export interface PlatformUserProfile {
  externalUserId: string;
  displayName: string;
  firstName?: string | null;
  lastName?: string | null;
  username?: string | null;
  isBot?: boolean;
  /** Полный ответ платформы — хранится как есть, про запас. */
  raw?: unknown;
}

/**
 * Профиль человека с платформы: единое место записи для всех, кто впервые
 * видит платформенного пользователя (участие в конкурсе, старт бота) или
 * фиксирует его согласие на обработку персональных данных.
 *
 * Вынесено из `ContestParticipationService` намеренно: согласие даётся при
 * старте бота, а не только при нажатии кнопки конкурса, и обработчикам
 * MAX-бота (`MaxModule`) нужен этот сервис напрямую, без захода в
 * контурсовые модули ради одной записи.
 */
@Injectable()
export class PlatformUsersService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Заводит или обновляет профиль. Вызывается при каждом взаимодействии:
   * человек мог сменить имя или username с прошлого раза.
   */
  async upsert(
    platform: Platform,
    user: PlatformUserProfile,
  ): Promise<{ id: string }> {
    return this.upsertRow(platform, user, {});
  }

  /** `false` и для отсутствующего профиля: согласия точно не было, если и профиля ещё нет. */
  async hasConsented(
    platform: Platform,
    externalUserId: string,
  ): Promise<boolean> {
    const row = await this.prisma.platformUser.findUnique({
      where: { platform_externalUserId: { platform, externalUserId } },
      select: { consentedAt: true },
    });
    return row?.consentedAt != null;
  }

  /**
   * Отмечает согласие на обработку персональных данных, заводя профиль,
   * если его ещё нет — согласие может быть первым, с чем человек к нам
   * пришёл, если он не участвовал ни в одном конкурсе.
   */
  async recordConsent(
    platform: Platform,
    user: PlatformUserProfile,
  ): Promise<void> {
    await this.upsertRow(platform, user, { consentedAt: new Date() });
  }

  /** Общий upsert для `upsert`/`recordConsent` — отличаются только полем согласия. */
  private async upsertRow(
    platform: Platform,
    user: PlatformUserProfile,
    consent: { consentedAt?: Date },
  ): Promise<{ id: string }> {
    return this.prisma.platformUser.upsert({
      where: {
        platform_externalUserId: {
          platform,
          externalUserId: user.externalUserId,
        },
      },
      create: {
        platform,
        externalUserId: user.externalUserId,
        ...PlatformUsersService.profileFields(user),
        ...consent,
      },
      update: {
        ...PlatformUsersService.profileFields(user),
        lastSeenAt: new Date(),
        ...consent,
      },
      select: { id: true },
    });
  }

  private static profileFields(user: PlatformUserProfile) {
    return {
      displayName: user.displayName,
      firstName: user.firstName ?? null,
      lastName: user.lastName ?? null,
      username: user.username ?? null,
      isBot: user.isBot ?? false,
      // Prisma не принимает голый `null` в Json-колонку — для «ничего нет»
      // у неё отдельное значение. Без этого любой вызов без сырого профиля
      // падал бы уже в рантайме.
      profile: (user.raw ?? Prisma.DbNull) as Prisma.InputJsonValue,
    };
  }
}
