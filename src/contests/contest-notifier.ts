import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../prisma/prisma.service';
import { MaxApiClient } from '../max/max-api.client';
import { MaxAdminResolver } from '../max/max-admin.resolver';
import { PostSender } from '../posts/post-sender';
import { ContestParticipationService } from './contest-participation.service';
import { announcementText, contestJoinPayload } from './contest-button';

/**
 * Всё, что происходит «наружу» по завершении розыгрыша: подмена кнопки под
 * анонсом, личное сообщение победителю и отчёт админу.
 *
 * Каждый шаг — best-effort и изолирован от остальных: розыгрыш уже состоялся
 * и записан, и недоставленное сообщение не должно ни откатывать его, ни
 * мешать остальным уведомлениям.
 */
@Injectable()
export class ContestNotifier {
  constructor(
    private readonly prisma: PrismaService,
    private readonly max: MaxApiClient,
    private readonly admins: MaxAdminResolver,
    private readonly participation: ContestParticipationService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(ContestNotifier.name);
  }

  async announceResults(
    contestId: string,
    reason: 'draw' | 'override' = 'draw',
  ): Promise<void> {
    await this.swapButtons(contestId);
    await this.notifyWinners(contestId);
    await this.notifyAdmins(contestId, reason);
  }

  /**
   * Меняет подпись кнопки под анонсом на «Узнать результаты». Проверено
   * живьём: MAX разрешает боту-администратору править своё сообщение вместе
   * с клавиатурой.
   *
   * Провал не критичен: обработчик нажатия отвечает по текущему статусу
   * конкурса, поэтому старая кнопка «Участвовать» всё равно отдаст
   * результаты, а не зарегистрирует опоздавшего.
   */
  private async swapButtons(contestId: string): Promise<void> {
    const contest = await this.prisma.contest.findUnique({
      where: { id: contestId },
      include: {
        post: {
          include: {
            deliveries: {
              where: { status: 'sent', group: { platform: 'max' } },
              include: { group: true },
            },
          },
        },
      },
    });

    if (!contest?.post) {
      return;
    }

    // Победители дописываются в сам пост: лс от бота доходит не всем, а пост
    // видят все подписчики. Временная мера до мини-аппа.
    const winners = contest.publishResultsInPost
      ? await this.participation.winnersList(contestId)
      : null;
    const text = announcementText(
      PostSender.resolveText(contest.post, 'max'),
      winners,
    );

    for (const delivery of contest.post.deliveries) {
      if (!delivery.externalMessageId) continue;
      try {
        // Правка заменяет сообщение целиком, поэтому медиа снимается со
        // старой версии и передаётся заново — иначе картинка анонса
        // исчезнет у всех.
        const current = await this.max.getMessageBody(
          delivery.externalMessageId,
        );
        if (current.unsupported.length > 0) {
          this.logger.warn(
            { contestId, dropped: current.unsupported },
            'Вложения анонса, которые нечем пересобрать, потеряются при правке',
          );
        }
        await this.max.editMessage(delivery.externalMessageId, text, {
          attachments: current.attachments,
          buttons: [
            [
              {
                type: 'callback',
                text: contest.resultsButtonLabel,
                payload: contestJoinPayload(contest.id),
              },
            ],
          ],
        });
      } catch (err: unknown) {
        this.logger.warn(
          { err, contestId, deliveryId: delivery.id },
          'Не удалось обновить анонс конкурса — останется кнопка «Участвовать», результаты отдаст обработчик нажатия',
        );
      }
    }
  }

  /**
   * Личное сообщение победителю. Отключаемо флагом конкурса: рассылка в лс
   * уместна не всегда, и это решение владельца, а не системы.
   *
   * Участник без id платформы или недоставленное сообщение — не тишина, а
   * явный статус `manual_required`: победитель не должен потеряться из-за
   * того, что бот не смог ему написать.
   */
  private async notifyWinners(contestId: string): Promise<void> {
    const contest = await this.prisma.contest.findUnique({
      where: { id: contestId },
      select: { notifyWinners: true, title: true },
    });
    if (!contest) return;

    // Только те, кого ещё не уведомляли: после правки места повторный
    // прогон не должен снова поздравлять тех, кто получил лс при розыгрыше.
    const prizes = await this.prisma.contestPrize.findMany({
      where: {
        contestId,
        winnerParticipantId: { not: null },
        notifyStatus: 'pending',
      },
      include: { winnerParticipant: true },
      orderBy: { place: 'asc' },
    });

    for (const prize of prizes) {
      const winner = prize.winnerParticipant;
      if (!winner) continue;

      if (!contest.notifyWinners) {
        await this.markNotify(
          prize.id,
          'manual_required',
          'Автоуведомление отключено',
        );
        continue;
      }

      // VK-конкурсы отложены: личку от сообщества может получить только тот,
      // кто сам в него писал, и бот-лонгполла у нас пока нет.
      // Только числовой id: у участника, добавленного вручную по @нику,
      // в этом поле лежит ник, а не id, и `Number()` дал бы NaN — лс ушло бы
      // в никуда с невнятной ошибкой платформы.
      if (
        winner.platform !== 'max' ||
        !/^\d+$/.test(winner.externalUserId ?? '')
      ) {
        await this.markNotify(
          prize.id,
          'manual_required',
          'Нет числового MAX-id участника — уведомить можно только вручную',
        );
        continue;
      }

      try {
        await this.max.sendMessageToUser(
          Number(winner.externalUserId),
          `Поздравляем! Вы заняли ${prize.place} место в конкурсе «${contest.title}»: ${prize.label}.`,
        );
        await this.markNotify(prize.id, 'sent');
      } catch (err: unknown) {
        // Самая частая причина — человек никогда не писал боту: MAX такое
        // сообщение не доставит. Ожидаемый исход, а не сбой.
        this.logger.warn(
          { err, contestId, prizeId: prize.id },
          'Не удалось уведомить победителя — помечено как «уведомить вручную»',
        );
        await this.markNotify(
          prize.id,
          'manual_required',
          err instanceof Error ? err.message : 'Неизвестная ошибка',
        );
      }
    }
  }

  private async markNotify(
    prizeId: string,
    status: 'sent' | 'manual_required',
    error?: string,
  ): Promise<void> {
    await this.prisma.contestPrize.update({
      where: { id: prizeId },
      data: {
        notifyStatus: status,
        notifyError: error ?? null,
        notifyAttemptedAt: new Date(),
      },
    });
  }

  /** Отчёт админу: какой конкурс, в каких группах шёл и кто победил. */
  private async notifyAdmins(
    contestId: string,
    reason: 'draw' | 'override',
  ): Promise<void> {
    const admins = await this.admins.listNotifiableAdmins();
    if (admins.length === 0) {
      this.logger.warn(
        { contestId },
        'Нет администраторов с привязанным maxUserId — отчёт о розыгрыше не отправлен',
      );
      return;
    }

    const contest = await this.prisma.contest.findUnique({
      where: { id: contestId },
      select: {
        title: true,
        post: {
          select: {
            deliveries: {
              where: { status: 'sent' },
              select: { group: { select: { title: true } } },
            },
          },
        },
      },
    });
    if (!contest) return;

    const groups = contest.post?.deliveries
      .map((d) => d.group.title)
      .join(', ');
    const where = groups ? `\nГруппы: ${groups}` : '';
    const headline =
      reason === 'override'
        ? `Конкурс «${contest.title}»: победитель изменён вручную.`
        : `Конкурс «${contest.title}» завершён.`;
    const text = `${headline}${where}\n\n${await this.participation.winnersList(contestId)}`;

    for (const admin of admins) {
      try {
        await this.max.sendMessageToUser(Number(admin.maxUserId), text);
      } catch (err: unknown) {
        this.logger.warn(
          { err, contestId, adminId: admin.id },
          'Не удалось отправить админу отчёт о розыгрыше',
        );
      }
    }
  }
}
