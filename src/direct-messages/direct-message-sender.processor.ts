import { Processor, WorkerHost } from '@nestjs/bullmq';
import { DelayedError, Job } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../prisma/prisma.service';
import { GroupRateLimiter } from '../queue/group-rate-limiter';
import { MaxApiClient } from '../max/max-api.client';
import { PostSender } from '../posts/post-sender';
import { AttachmentUploader } from '../posts/attachment-uploader';
import { classifyDeliveryError } from '../posts/delivery-outcome';
import { sleep } from '../common/sleep';
import {
  DIRECT_MESSAGE_QUEUE,
  DeliverDirectMessageJob,
} from '../queue/queue.constants';

/**
 * Одна и та же строка получателя, а не per-получатель ключ: в отличие от
 * постов, где у каждой группы (для VK — общины) свой токен, все личные
 * сообщения идут через один и тот же бот-токен MAX — пейсить нужно общий
 * поток, а не каждого получателя отдельно.
 */
const DM_RATE_LIMIT_KEY = 'direct-messages';

/**
 * Отправляет одно личное сообщение с текстом поста. Один джоб — один
 * получатель, по той же причине, что и у `PostDeliveryProcessor`: получатели
 * независимы, провал у одного не должен останавливать остальных.
 */
@Processor(DIRECT_MESSAGE_QUEUE, { concurrency: 5 })
export class DirectMessageSenderProcessor extends WorkerHost {
  constructor(
    private readonly prisma: PrismaService,
    private readonly max: MaxApiClient,
    private readonly attachments: AttachmentUploader,
    private readonly rateLimiter: GroupRateLimiter,
    private readonly logger: PinoLogger,
  ) {
    super();
    this.logger.setContext(DirectMessageSenderProcessor.name);
  }

  async process(job: Job<DeliverDirectMessageJob>): Promise<void> {
    const { deliveryId } = job.data;
    const delivery = await this.prisma.directMessageDelivery.findUnique({
      where: { id: deliveryId },
      select: {
        status: true,
        post: {
          select: {
            text: true,
            vkTextOverride: true,
            maxTextOverride: true,
            attachments: {
              orderBy: { position: 'asc' },
              include: { mediaAsset: true },
            },
          },
        },
        platformUser: { select: { platform: true, externalUserId: true } },
      },
    });
    if (!delivery) {
      this.logger.warn({ deliveryId }, 'Доставка в личку исчезла — пропуск');
      return;
    }
    // Тот же смысл, что и у PostDeliveryProcessor: строка — источник правды,
    // а не джоб. Дубликат джоба находит уже не-pending строку и молча выходит.
    if (delivery.status !== 'pending') {
      this.logger.info(
        { deliveryId, status: delivery.status },
        'Доставка в личку уже не в статусе pending — пропуск',
      );
      return;
    }

    // Тот же класс проверки, что уже есть в ContestNotifier.notifyWinners:
    // сейчас реально слать можно только в MAX и только по числовому id
    // (у участника, добавленного вручную по нику, здесь лежал бы ник).
    // Резолвер получателей (блок 2) намеренно этого не проверяет — это
    // работа воркера.
    if (
      delivery.platformUser.platform !== 'max' ||
      !/^\d+$/.test(delivery.platformUser.externalUserId)
    ) {
      await this.prisma.directMessageDelivery.update({
        where: { id: deliveryId },
        data: {
          status: 'manual_required',
          error:
            'Платформа или id получателя не поддерживают автоматическую отправку',
        },
      });
      return;
    }

    const slot = await this.rateLimiter.reserve(DM_RATE_LIMIT_KEY, 'max');
    if (!slot.acquired) {
      // Ничего не потрачено — джоб можно вернуть без штрафа за попытку.
      await job.moveToDelayed(Date.now() + slot.waitMs, job.token);
      throw new DelayedError();
    }
    if (slot.waitMs > 0) {
      await sleep(slot.waitMs);
    }

    // Коммитится до сетевого вызова — та же причина, что и у постов: упавший
    // посреди отправки воркер оставляет след, а не тихо теряет попытку.
    await this.prisma.directMessageDelivery.update({
      where: { id: deliveryId },
      data: { status: 'sending', attemptsMade: { increment: 1 } },
    });

    let externalMessageId: string;
    try {
      // Личка — только MAX (гвард выше), поэтому конвертировать вложения
      // для VK здесь незачем — `maxAttachments` тот же кэш, что и у
      // рассылки постов в группы.
      const attachments = await this.attachments.maxAttachments(
        delivery.post.attachments.map((attachment) => attachment.mediaAsset),
      );
      const result = await this.max.sendMessageToUser(
        Number(delivery.platformUser.externalUserId),
        PostSender.resolveText(delivery.post, 'max'),
        { attachments },
      );
      externalMessageId = result.messageId;
    } catch (err: unknown) {
      await this.handleError(job, deliveryId, err);
      return;
    }

    // Тот же приём, что у `PostDeliveryProcessor`: дальше сообщение уже
    // существует на платформе, и бросок отсюда — незаконченная попытка для
    // BullMQ, только строка остаётся `sending` навсегда (guard вверху не
    // пускает повтор ни в `sending`, ни в `sent` — задваивания не будет, но
    // и правды в базе тоже). В отличие от `PostDelivery`, у
    // `DirectMessageDelivery` нет сверщика зависших доставок — если и это
    // письмо в базу не пройдёт, строка так и останется без ответа, только
    // вручную.
    try {
      await this.prisma.directMessageDelivery.update({
        where: { id: deliveryId },
        data: {
          status: 'sent',
          externalMessageId,
          sentAt: new Date(),
          error: null,
        },
      });
    } catch (err: unknown) {
      this.logger.error(
        { err, deliveryId, externalMessageId },
        'Личное сообщение отправлено, но результат не записан в БД',
      );
      await this.markUnknownAfterSend(deliveryId, externalMessageId);
    }
  }

  private async markUnknownAfterSend(
    deliveryId: string,
    externalMessageId: string,
  ): Promise<void> {
    try {
      await this.prisma.directMessageDelivery.update({
        where: { id: deliveryId },
        data: {
          status: 'unknown',
          externalMessageId,
          error:
            'Сообщение отправлено, но запись результата не удалась. Проверьте вручную.',
        },
      });
    } catch (err: unknown) {
      this.logger.error(
        { err, deliveryId },
        'Не удалось пометить личное сообщение как unknown — останется sending без сверщика',
      );
    }
  }

  private async handleError(
    job: Job<DeliverDirectMessageJob>,
    deliveryId: string,
    err: unknown,
  ): Promise<void> {
    const outcome = classifyDeliveryError(err);
    const isLastAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);

    if (outcome.kind === 'retryable' && !isLastAttempt) {
      await this.prisma.directMessageDelivery.update({
        where: { id: deliveryId },
        data: { status: 'pending', error: outcome.message },
      });
      throw err;
    }

    // `ambiguous` (исход неясен — транспорт мог доставить сообщение и
    // потерять только ответ) идёт в `unknown`, не в `failed`: строка
    // `failed` приглашает считать, что ничего не ушло, а ручной повтор тем
    // же текстом новым постом не защищён unique(postId, platformUserId) —
    // это новый postId. Тот же смысл, что и у PostDeliveryStatus.unknown.
    const status = outcome.kind === 'ambiguous' ? 'unknown' : 'failed';
    await this.prisma.directMessageDelivery.update({
      where: { id: deliveryId },
      data: { status, error: outcome.message },
    });

    this.logger.warn(
      { deliveryId, outcome: outcome.kind, err },
      'Личное сообщение не доставлено',
    );
  }
}
