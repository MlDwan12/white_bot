import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { AppException } from '../common/app-exception';
import { ErrorCode } from '../common/error-code.enum';
import { PrismaService } from '../prisma/prisma.service';
import { PostSender } from './post-sender';
import { PostsService } from './posts.service';
import { joinButtonText } from '../contests/contest-button';

export interface ModerationOutcome {
  /** Сколько сообщений реально удалено/отредактировано. */
  succeeded: number;
  /** По одной записи на каждую неудачу: группа и причина. */
  failed: { groupId: string; groupTitle: string; error: string }[];
}

export interface EditPublishedInput {
  text?: string;
  vkTextOverride?: string | null;
  maxTextOverride?: string | null;
  autoDeleteAt?: Date | null;
  autoDeleteAfterMinutes?: number | null;
}

/** Сколько доставок сверщик берёт за один проход. */
const SWEEP_BATCH = 200;

/**
 * После скольких неудач автоудаление сдаётся. Строка, которую нельзя
 * удалить в принципе — например, VK без одобренных прав, — иначе вечно
 * занимала бы место в окне выборки.
 */
const MAX_AUTO_DELETE_ATTEMPTS = 5;

/** Сколько ждём, пока доставки, начатые до стопа, допишут результат. */
const DRAIN_TIMEOUT_MS = 15_000;
const DRAIN_POLL_MS = 500;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

@Injectable()
export class PostModerationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sender: PostSender,
    private readonly posts: PostsService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(PostModerationService.name);
  }

  /**
   * Удаляет уже опубликованное — во всех группах или в выбранных.
   *
   * Выбор групп не роскошь: на пост может пожаловаться одна площадка, и
   * сносить его везде из-за этого незачем.
   */
  async deletePublished(
    postId: string,
    groupIds?: string[],
  ): Promise<ModerationOutcome> {
    const deliveries = await this.publishedDeliveries(postId, groupIds);
    if (deliveries.length === 0) {
      throw new AppException(
        ErrorCode.NOT_FOUND,
        'Нечего удалять: в этих группах пост не опубликован',
      );
    }

    const outcome: ModerationOutcome = { succeeded: 0, failed: [] };

    for (const delivery of deliveries) {
      try {
        await this.sender.delete(delivery.group, delivery.externalMessageId!);
        // Срок автоудаления снимается: удалять уже нечего, а оставленная
        // дата заставляла бы сверщик возвращаться к этой строке вечно.
        await this.recordOutcome(delivery.id, {
          deletedAt: new Date(),
          autoDeleteDueAt: null,
          error: null,
        });
        outcome.succeeded += 1;
      } catch (err: unknown) {
        // Провал в одной группе не отменяет остальные: «слишком старое
        // сообщение» или «уже удалено руками» касается только её.
        const message = describe(err);
        this.logger.warn(
          { err, postId, groupId: delivery.groupId },
          'Не удалось удалить опубликованное сообщение',
        );
        await this.recordOutcome(delivery.id, { error: message });
        outcome.failed.push({
          groupId: delivery.groupId,
          groupTitle: delivery.group.title,
          error: message,
        });
      }
    }

    return outcome;
  }

  /**
   * Правит пост и проталкивает новый текст во все уже отправленные доставки.
   *
   * Если рассылка ещё идёт, она сначала останавливается: иначе часть групп
   * получила бы старый текст, а часть новый, и кампания навсегда осталась бы
   * с двумя разными версиями. Необработанные доставки уходят в
   * `skipped_by_stop`, и «отправить оставшимся» потом дошлёт уже новый текст.
   */
  async editPublished(
    postId: string,
    input: EditPublishedInput,
  ): Promise<ModerationOutcome> {
    const post = await this.prisma.post.findUnique({ where: { id: postId } });
    if (!post) {
      throw new AppException(ErrorCode.NOT_FOUND, 'Пост не найден');
    }
    if (post.recurrenceRule) {
      // Иначе правка тихо переписала бы шаблон и вернула пустую сводку:
      // доставок у него нет, и «успешно ничего» выглядело бы как успех.
      throw new AppException(
        ErrorCode.REQUEST_ERROR,
        'Это повторяющийся шаблон — им управляют через /post-templates',
      );
    }

    if (post.status === 'sending') {
      await this.posts.stopPost(postId);
      // Стоп помечает только необработанные. Доставки, у которых вызов уже
      // в полёте, допишутся `sent` **после** снимка ниже — и остались бы со
      // старым текстом навсегда, ровно вопреки смыслу правки. Ждём, пока
      // они осядут.
      await this.drainInFlight(postId);
    }

    const updated = await this.prisma.post.update({
      where: { id: postId },
      data: {
        ...(input.text !== undefined ? { text: input.text } : {}),
        ...(input.vkTextOverride !== undefined
          ? { vkTextOverride: input.vkTextOverride }
          : {}),
        ...(input.maxTextOverride !== undefined
          ? { maxTextOverride: input.maxTextOverride }
          : {}),
        ...(input.autoDeleteAt !== undefined
          ? { autoDeleteAt: input.autoDeleteAt }
          : {}),
        ...(input.autoDeleteAfterMinutes !== undefined
          ? { autoDeleteAfterMinutes: input.autoDeleteAfterMinutes }
          : {}),
      },
      include: {
        attachments: {
          orderBy: { position: 'asc' },
          include: { mediaAsset: true },
        },
        contest: true,
      },
    });

    const assets = updated.attachments.map((a) => a.mediaAsset);

    // Кнопка конкурса передаётся при правке заново: в MAX клавиатура — такое
    // же вложение, и правка без неё снесла бы «Участвовать» во всех группах.
    const contestButton = updated.contest
      ? {
          contestId: updated.contest.id,
          label: joinButtonText(
            updated.contest.joinButtonLabel,
            await this.prisma.contestParticipant.count({
              where: { contestId: updated.contest.id },
            }),
          ),
        }
      : null;

    const deliveries = await this.publishedDeliveries(postId);

    // Срок автоудаления пересчитывается до и независимо от похода на
    // платформу: он не требует сетевого вызова, и привязывать его к успеху
    // правки значило бы, что правка ради одной лишь смены срока (а в VK она
    // сейчас всегда падает) не меняет ничего вовсе.
    for (const delivery of deliveries) {
      await this.recordOutcome(delivery.id, {
        autoDeleteDueAt: autoDeleteDueAt(updated, delivery.sentAt),
        autoDeleteAttempts: 0,
      });
    }

    const outcome: ModerationOutcome = { succeeded: 0, failed: [] };

    for (const delivery of deliveries) {
      try {
        await this.sender.edit(
          updated,
          delivery.group,
          delivery.externalMessageId!,
          assets,
          contestButton,
        );
        await this.recordOutcome(delivery.id, { error: null });
        outcome.succeeded += 1;
      } catch (err: unknown) {
        const message = describe(err);
        this.logger.warn(
          { err, postId, groupId: delivery.groupId },
          'Не удалось обновить опубликованное сообщение',
        );
        await this.recordOutcome(delivery.id, { error: message });
        outcome.failed.push({
          groupId: delivery.groupId,
          groupTitle: delivery.group.title,
          error: message,
        });
      }
    }

    return outcome;
  }

  /**
   * Ждёт, пока доставки, начатые до стопа, допишут свой результат.
   *
   * Ограничено по времени: если воркер умер на полпути, строка останется в
   * `sending` до сверщика, и ждать её здесь бесконечно — значит подвесить
   * запрос админа. Не дождались — правка идёт по тому, что уже отправлено, а
   * опоздавшая группа останется со старым текстом и увидит его в ошибке.
   */
  private async drainInFlight(postId: string): Promise<void> {
    const deadline = Date.now() + DRAIN_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const inFlight = await this.prisma.postDelivery.count({
        where: { postId, status: 'sending' },
      });
      if (inFlight === 0) {
        return;
      }
      await sleep(DRAIN_POLL_MS);
    }
    this.logger.warn(
      { postId },
      'Доставки не осели за отведённое время: часть групп может остаться со старым текстом',
    );
  }

  /**
   * Удаляет то, чему вышел срок. Зовётся сверщиком раз в минуту — отдельного
   * таймера не заводим: один планировщик, один лок, одно место отказа.
   */
  async sweepAutoDeletions(now: Date): Promise<number> {
    const due = await this.prisma.postDelivery.findMany({
      where: {
        status: 'sent',
        deletedAt: null,
        autoDeleteDueAt: { not: null, lte: now },
      },
      include: { group: true },
      // Сначала те, кому пора дольше всех. Без явного порядка строка,
      // которую удалить нельзя в принципе (VK без одобренных прав),
      // навсегда занимала бы место в окне и вытесняла тех, кого можно.
      orderBy: { autoDeleteDueAt: 'asc' },
      take: SWEEP_BATCH,
    });

    let deleted = 0;
    for (const delivery of due) {
      if (!delivery.externalMessageId) {
        // Удалять нечего: id сообщения потерян (доставка ушла в `unknown`
        // после публикации). Срок снимаем, иначе строка будет занимать
        // место в окне на каждом проходе, ничего не двигая.
        await this.recordOutcome(delivery.id, {
          autoDeleteDueAt: null,
          error: 'Автоудаление невозможно: неизвестен id сообщения',
        });
        continue;
      }
      try {
        await this.sender.delete(delivery.group, delivery.externalMessageId);
        await this.recordOutcome(delivery.id, {
          deletedAt: now,
          autoDeleteDueAt: null,
          error: null,
        });
        deleted += 1;
      } catch (err: unknown) {
        const attempts = delivery.autoDeleteAttempts + 1;
        const giveUp = attempts >= MAX_AUTO_DELETE_ATTEMPTS;
        this.logger.warn(
          { err, deliveryId: delivery.id, groupId: delivery.groupId, attempts },
          giveUp
            ? 'Автоудаление не удалось окончательно — сдаёмся, удалять вручную'
            : 'Автоудаление не удалось, попробуем на следующем проходе',
        );
        await this.recordOutcome(delivery.id, {
          autoDeleteAttempts: attempts,
          // Сдавшись, снимаем срок: иначе безнадёжная строка навсегда
          // осталась бы в окне выборки. Ошибка при этом остаётся видна.
          ...(giveUp ? { autoDeleteDueAt: null } : {}),
          error: describe(err),
        });
      }
    }

    if (deleted > 0) {
      this.logger.info({ deleted }, 'Автоудаление отработало');
    }
    return deleted;
  }

  /**
   * Запись результата по одной доставке. Собственная защита нужна потому,
   * что это происходит внутри цикла: сбой базы здесь иначе вылетел бы
   * наружу, и вызывающий потерял бы сводку по уже обработанным группам —
   * включая знание о том, что сообщения **уже удалены** с платформы.
   */
  private async recordOutcome(
    deliveryId: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.prisma.postDelivery.update({
        where: { id: deliveryId },
        data,
      });
    } catch (err: unknown) {
      this.logger.error(
        { err, deliveryId },
        'Не удалось записать результат по доставке — действие на платформе уже выполнено',
      );
    }
  }

  private async publishedDeliveries(postId: string, groupIds?: string[]) {
    return this.prisma.postDelivery.findMany({
      where: {
        postId,
        status: 'sent',
        deletedAt: null,
        externalMessageId: { not: null },
        ...(groupIds && groupIds.length > 0
          ? { groupId: { in: groupIds } }
          : {}),
      },
      include: { group: true },
    });
  }
}

/**
 * Когда эту доставку пора удалить. Абсолютная дата имеет приоритет над
 * относительной: если заданы обе, «в 18:00» звучит определённее, чем «через
 * час», и выбирать между ними молча по какому-то другому правилу было бы
 * сюрпризом.
 */
export function autoDeleteDueAt(
  post: { autoDeleteAt: Date | null; autoDeleteAfterMinutes: number | null },
  sentAt: Date | null,
): Date | null {
  if (post.autoDeleteAt) {
    return post.autoDeleteAt;
  }
  if (post.autoDeleteAfterMinutes && sentAt) {
    return new Date(sentAt.getTime() + post.autoDeleteAfterMinutes * 60_000);
  }
  return null;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : 'Неизвестная ошибка';
}
