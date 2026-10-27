import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../prisma/prisma.service';
import { MaxApiClient } from '../max/max-api.client';
import { AdminNotifier } from '../max/admin-notifier';
import { ContestParticipationService } from './contest-participation.service';
import {
  contestExtendPayload,
  rewriteAnnouncement,
  winnerCongratulation,
} from './contest-button';

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
    private readonly adminNotifier: AdminNotifier,
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

  /** Отмена: пост — «Конкурс отменён» без кнопки, админам — сообщение. */
  async announceCancelled(contestId: string): Promise<void> {
    await this.swapButtons(contestId);
    const contest = await this.prisma.contest.findUnique({
      where: { id: contestId },
      select: { title: true },
    });
    if (contest) {
      await this.adminNotifier.notifyAll(
        `Конкурс «${contest.title}» отменён: к сроку не набралось ни одного участника.`,
      );
    }
  }

  /** «Через 10 минут конец, участников нет» — с кнопками продления. */
  async warnEmptyEnding(contestId: string, title: string): Promise<void> {
    await this.adminNotifier.notifyAll(
      `В конкурсе «${title}» нет ни одного участника, а до конца меньше 10 минут. Если не продлить, конкурс отменится.`,
      [
        [
          {
            type: 'callback',
            text: 'Продлить на сутки',
            payload: contestExtendPayload(contestId, 1),
          },
          {
            type: 'callback',
            text: 'Продлить на 3 дня',
            payload: contestExtendPayload(contestId, 3),
          },
        ],
      ],
    );
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
    // Тот же вид, что собирают все остальные перерисовки (итоги и «Узнать
    // результаты» — по статусу конкурса), а не своя копия.
    const view = await this.participation.announcementRefresh(contestId);
    if (!view) {
      return;
    }
    // Ссылка на бота остаётся и после розыгрыша: победитель, который открыл
    // диалог позже, получает поздравление сразу при старте.
    await rewriteAnnouncement(
      this.max,
      contestId,
      view,
      (err, messageId) =>
        this.logger.warn(
          { err, contestId, messageId },
          'Не удалось обновить анонс конкурса — останется кнопка «Участвовать», результаты отдаст обработчик нажатия',
        ),
      (dropped) =>
        this.logger.warn(
          { contestId, dropped },
          'Вложения анонса, которые нечем пересобрать, потеряются при правке',
        ),
    );
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
      // Только сам нажавший кнопку: у участника, добавленного вручную по
      // @нику, в этом поле лежит ник, а не id. Даже цифровой ник
      // (`Иван @100500`) — не id: `Number()` дал бы id постороннего человека,
      // и поздравление ушло бы ему.
      if (
        winner.source !== 'button' ||
        winner.platform !== 'max' ||
        !/^\d+$/.test(winner.externalUserId ?? '')
      ) {
        await this.markNotify(
          prize.id,
          'manual_required',
          'Участник добавлен вручную или без MAX-id — уведомить можно только вручную',
        );
        continue;
      }

      try {
        await this.max.sendMessageToUser(
          Number(winner.externalUserId),
          winnerCongratulation(prize.place, contest.title, prize.label),
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

    // Общая рассылка админам: та же обработка «нет админов», «MAX не
    // настроен» и сбоев по одному — без своей копии этого цикла.
    await this.adminNotifier.notifyAll(text);
  }
}
