import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';
import { AppException } from '../common/app-exception';
import { ErrorCode } from '../common/error-code.enum';
import { PrismaService } from '../prisma/prisma.service';
import {
  DIRECT_MESSAGE_QUEUE,
  DeliverDirectMessageJob,
  JOB_DELIVER_DIRECT_MESSAGE,
  deliverDirectMessageJobId,
} from '../queue/queue.constants';
import {
  DirectMessageRecipientSelector,
  DirectMessageRecipientsService,
} from './direct-message-recipients.service';

const SEND_ATTEMPTS = 3;
const SEND_BACKOFF_MS = 5_000;

/**
 * Постановка в очередь идёт батчами этого размера, а не одним `Promise.all`
 * на все строки разом: у режима «все в базе» получателей может быть на
 * порядки больше, чем групп у поста (для которых этот приём с одним
 * `Promise.all` изначально писался в `PostDeliveryProcessor`), и
 * неограниченная параллельность утопила бы Redis разом при большой базе.
 */
const ENQUEUE_BATCH_SIZE = 50;

/**
 * Запускает рассылку поста в личку: разворачивает выбор получателей,
 * замораживает список строками `DirectMessageDelivery` (та же идея, что у
 * `PostDelivery` — админ видит, кому реально уйдёт, список не пересчитывается
 * на лету) и ставит по джобу на каждую ожидающую строку.
 *
 * Без отдельной фазы «dispatch», в отличие от постов: у рассылки в личку нет
 * расписания на будущее (обсуждено и решено — рассылаем существующий пост
 * немедленно), поэтому резолвинг получателей и создание строк происходят в
 * момент вызова синхронно, без промежуточного джоба.
 */
@Injectable()
export class DirectMessageDispatchService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly recipients: DirectMessageRecipientsService,
    @InjectQueue(DIRECT_MESSAGE_QUEUE) private readonly queue: Queue,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(DirectMessageDispatchService.name);
  }

  /**
   * Идемпотентна: повторный вызов с тем же выбором не задваивает уже
   * созданные строки (`unique(postId, platformUserId)` + `skipDuplicates`) и
   * заодно доставит любые `pending`, оставшиеся от прошлого неудачного
   * запуска (например, обрыв между `createMany` и постановкой в очередь) —
   * вместо отдельного сверщика под этот узкий случай.
   */
  async sendNow(
    postId: string,
    selector: DirectMessageRecipientSelector,
  ): Promise<{ queued: number }> {
    const post = await this.prisma.post.findUnique({
      where: { id: postId },
      select: { id: true },
    });
    if (!post) {
      throw new AppException(ErrorCode.NOT_FOUND, 'Пост не найден');
    }

    const recipients = await this.recipients.resolve(selector);
    if (recipients.length === 0) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'Нет получателей, подходящих под выбор',
      );
    }

    await this.prisma.directMessageDelivery.createMany({
      data: recipients.map((recipient) => ({
        postId,
        platformUserId: recipient.id,
      })),
      skipDuplicates: true,
    });

    const pending = await this.prisma.directMessageDelivery.findMany({
      where: { postId, status: 'pending' },
      select: { id: true },
    });

    await this.enqueueAll(pending.map((delivery) => delivery.id));
    return { queued: pending.length };
  }

  /**
   * Батчами и через `allSettled`, а не одним `Promise.all` на все строки:
   * при большом числе получателей неограниченная параллельность утопила бы
   * Redis, а обрыв одной постановки не должен прерывать остальные — строка,
   * которой не досталось джоба, остаётся `pending` и получит его при
   * следующем (идемпотентном) запуске `sendNow`.
   */
  private async enqueueAll(deliveryIds: string[]): Promise<void> {
    for (let i = 0; i < deliveryIds.length; i += ENQUEUE_BATCH_SIZE) {
      const batch = deliveryIds.slice(i, i + ENQUEUE_BATCH_SIZE);
      const results = await Promise.allSettled(
        batch.map((deliveryId) => this.enqueue(deliveryId)),
      );
      results.forEach((result, index) => {
        if (result.status === 'rejected') {
          const err: unknown = result.reason;
          this.logger.warn(
            { deliveryId: batch[index], err },
            'Не удалось поставить личное сообщение в очередь — останется pending до следующего запуска',
          );
        }
      });
    }
  }

  /**
   * Тот же приём, что и у `PostDeliveryProcessor.enqueueDelivery`: BullMQ
   * отказывается переиспользовать id, ещё занятый *завершённым* джобом, так
   * что старый успех/провал сначала убирается, иначе строка навсегда
   * останется неперепоставляемой.
   */
  private async enqueue(deliveryId: string): Promise<void> {
    const jobId = deliverDirectMessageJobId(deliveryId);
    const existing = await this.queue.getJob(jobId);
    if (existing) {
      const finished = await Promise.all([
        existing.isCompleted().catch(() => false),
        existing.isFailed().catch(() => false),
      ]);
      if (finished.some(Boolean)) {
        await existing.remove().catch(() => undefined);
      }
    }

    await this.queue.add(
      JOB_DELIVER_DIRECT_MESSAGE,
      { deliveryId } satisfies DeliverDirectMessageJob,
      {
        jobId,
        attempts: SEND_ATTEMPTS,
        backoff: { type: 'exponential', delay: SEND_BACKOFF_MS },
        removeOnComplete: true,
        removeOnFail: true,
      },
    );
  }
}
