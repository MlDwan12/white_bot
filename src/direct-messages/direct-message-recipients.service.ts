import { Injectable } from '@nestjs/common';
import { AppException } from '../common/app-exception';
import { ErrorCode } from '../common/error-code.enum';
import { PrismaService } from '../prisma/prisma.service';
import { Platform } from '../generated/prisma/client';

/** Кого выбрал админ в форме рассылки — три взаимоисключающих режима. */
export type DirectMessageRecipientSelector =
  | { mode: 'user'; platformUserId: string }
  | { mode: 'group'; groupId: string }
  | { mode: 'all' };

/**
 * Тот минимум о получателе, которого достаточно, чтобы его найти на
 * платформе. Имя и username здесь не нужны — это для очереди отправки
 * (блок 3), а не для отображения в форме.
 */
export interface DirectMessageRecipient {
  id: string;
  platform: Platform;
  externalUserId: string;
}

const RECIPIENT_SELECT = {
  id: true,
  platform: true,
  externalUserId: true,
} as const;

/**
 * Разворачивает выбор админа («этому человеку» / «участникам этой группы» /
 * «всем в базе») в список получателей. Только это — ни платформа отправки
 * (сейчас реально может слать только MAX), ни валидность id как числа здесь
 * не проверяются: это забота очереди отправки, как уже сделано в
 * `ContestNotifier.notifyWinners` для того же класса проверок.
 */
@Injectable()
export class DirectMessageRecipientsService {
  constructor(private readonly prisma: PrismaService) {}

  async resolve(
    selector: DirectMessageRecipientSelector,
  ): Promise<DirectMessageRecipient[]> {
    switch (selector.mode) {
      case 'user':
        return [await this.resolveUser(selector.platformUserId)];
      case 'group':
        return this.resolveGroup(selector.groupId);
      case 'all':
        return this.resolveAll();
    }
  }

  /**
   * Конкретный человек, выбранный через поиск (блок 1). Согласие
   * перепроверяется здесь же: то, что он нашёлся в поиске, не гарантирует,
   * что он не отозвал согласие между поиском и отправкой формы.
   *
   * Несуществующий id и отозванное согласие дают одну и ту же ошибку
   * намеренно: раскрывать админу «этот человек был, но отозвал согласие» —
   * это утечка факта о конкретном человеке, а не просто неудобство UX.
   */
  private async resolveUser(
    platformUserId: string,
  ): Promise<DirectMessageRecipient> {
    const user = await this.prisma.platformUser.findUnique({
      where: { id: platformUserId },
      select: { ...RECIPIENT_SELECT, consentedAt: true },
    });
    if (!user || user.consentedAt == null) {
      throw new AppException(ErrorCode.NOT_FOUND, 'Получатель не найден');
    }
    return {
      id: user.id,
      platform: user.platform,
      externalUserId: user.externalUserId,
    };
  }

  /**
   * Уникальные `PlatformUser`, участвовавшие в конкурсе, чей анонс уходил
   * в эту группу — считаем по доставкам поста (`Contest.post.deliveries`),
   * а не по `ContestParticipant.groupId` самого участника.
   *
   * Раньше было наоборот, и это ломалось ровно там, где рассылка нужнее
   * всего: участие в MAX сейчас идёт по кнопке-ссылке под постом
   * (`contestDmUrl`), а не по колбэку в конкретной группе, и `join()`
   * пишет `groupId` участника только когда у поста ровно одна MAX-доставка
   * (`soleDeliveryGroup`). У любого конкурса, кросс-постнутого в 2+
   * MAX-группы, `groupId` участника всегда `null` — «Участникам группы»
   * находил бы пустой список для реально существующих согласившихся
   * участников. Доставки поста, в отличие от участника, всегда знают, в
   * какие группы он ушёл, независимо от того, как человек присоединился.
   *
   * Менее точно (участник мог увидеть анонс в любой из групп конкурса, а
   * не именно в выбранной), зато не даёт молчаливый пустой результат для
   * мульти-групповых конкурсов — расплата признана оправданной.
   *
   * Группа проверяется на существование явно: без этого мистайпленный или
   * удалённый id молча дал бы пустой список получателей — неотличимо от
   * «у этой группы просто нет согласившихся участников» — и рассылка
   * «успешно» ушла бы никому.
   */
  private async resolveGroup(
    groupId: string,
  ): Promise<DirectMessageRecipient[]> {
    const group = await this.prisma.group.findUnique({
      where: { id: groupId },
      select: { id: true },
    });
    if (!group) {
      throw new AppException(ErrorCode.NOT_FOUND, 'Группа не найдена');
    }
    return this.prisma.platformUser.findMany({
      where: {
        consentedAt: { not: null },
        contestEntries: {
          some: { contest: { post: { deliveries: { some: { groupId } } } } },
        },
      },
      select: RECIPIENT_SELECT,
    });
  }

  private async resolveAll(): Promise<DirectMessageRecipient[]> {
    return this.prisma.platformUser.findMany({
      where: { consentedAt: { not: null } },
      select: RECIPIENT_SELECT,
    });
  }
}
