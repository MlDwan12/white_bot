import { Injectable } from '@nestjs/common';
import { AppException } from '../common/app-exception';
import { ErrorCode } from '../common/error-code.enum';
import { PrismaService } from '../prisma/prisma.service';
import { PostSender } from '../posts/post-sender';
import { type PlatformUserProfile } from '../platform-users/platform-users.service';
import { ContestParticipationService } from './contest-participation.service';
import { ContestView, ContestWinnerView, shortenName } from './contest-view';

export interface MiniAppViewer {
  externalUserId: string;
  profile: PlatformUserProfile;
  chatId?: number;
}

/**
 * Обслуживает мини-приложение: показывает состояние конкурса и записывает
 * участие.
 *
 * Личность приходит уже проверенной — гвард сверил подпись данных запуска.
 * А вот id конкурса доверенным **не** является: он берётся из `start_param`
 * диплинка, а такую ссылку с любым id может открыть кто угодно, и MAX
 * подпишет то, что ему дали. Подпись доказывает «запуск настоящий», а не
 * «этот конкурс предназначен этому человеку», поэтому право на просмотр
 * проверяется здесь отдельно.
 */
@Injectable()
export class MiniAppService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly participation: ContestParticipationService,
  ) {}

  async getContest(
    contestId: string,
    viewer: MiniAppViewer,
  ): Promise<ContestView> {
    const contest = await this.loadContest(contestId);

    const [participantsCount, mine] = await Promise.all([
      this.prisma.contestParticipant.count({ where: { contestId } }),
      this.findViewerEntry(contestId, viewer.externalUserId),
    ]);

    const winners =
      contest.status === 'drawn' ? await this.winners(contestId, mine?.id) : [];

    return {
      id: contest.id,
      title: contest.title,
      // Пост здесь всегда есть: `loadContest` не отдаёт конкурс без
      // опубликованного анонса. Проверка оставлена для типов.
      terms: contest.post ? PostSender.resolveText(contest.post, 'max') : '',
      status: contest.status,
      participantsCount,
      placesCount: contest.prizes.length,
      joined: mine !== null,
      winners,
    };
  }

  /**
   * Участие. Регистрация идёт через тот же сервис, что и нажатие кнопки под
   * постом, — правила приёма и дедупликация не должны зависеть от того,
   * откуда человек пришёл.
   */
  async join(contestId: string, viewer: MiniAppViewer): Promise<ContestView> {
    const outcome = await this.participation.join({
      contestId,
      platform: 'max',
      user: viewer.profile,
      groupExternalId: String(viewer.chatId ?? ''),
    });

    // Молча ответить «успех» там, где участие не записано, — худший из
    // вариантов: страница показала бы «вы участвуете», а человека в конкурсе
    // нет. Поэтому каждый отказ платформы превращается в свою ошибку.
    switch (outcome.status) {
      case 'unknown_contest':
        throw new AppException(ErrorCode.NOT_FOUND, 'Конкурс не найден');
      case 'not_open':
        throw new AppException(
          ErrorCode.VALIDATION_ERROR,
          'Приём участников ещё не открыт',
        );
      case 'drawn':
        throw new AppException(
          ErrorCode.CONTEST_ALREADY_DRAWN,
          'Розыгрыш уже проведён — участвовать поздно',
        );
      case 'consent_required':
        // Мини-приложение сейчас не запускается без диалога с ботом
        // (заблокировано доступом к настройкам партнёра), но проверка
        // здесь на случай, когда это изменится: без неё участие записалось
        // бы в обход экрана согласия, который показывает только бот.
        throw new AppException(
          ErrorCode.VALIDATION_ERROR,
          'Нужно сначала открыть диалог с ботом и подтвердить согласие на обработку персональных данных',
        );
      default:
        // `joined` и `already_joined`: человек в конкурсе, и правильный
        // ответ — показать актуальное состояние, а не отказ.
        break;
    }

    return this.getContest(contestId, viewer);
  }

  /**
   * Конкурс виден мини-приложению, только если его анонс **действительно
   * опубликован**. Иначе по угаданной или подсмотренной ссылке можно было бы
   * прочитать черновик: название и полный текст ещё неопубликованного поста.
   *
   * Более строгой проверки (состоит ли человек в группе) здесь нет
   * сознательно: анонс уже показан всем подписчикам канала, так что скрывать
   * от них же нечего.
   */
  private async loadContest(contestId: string) {
    const contest = await this.prisma.contest.findUnique({
      where: { id: contestId },
      include: {
        post: {
          include: {
            deliveries: { where: { status: 'sent' }, select: { id: true } },
          },
        },
        prizes: { select: { id: true } },
      },
    });
    if (
      !contest ||
      contest.post === null ||
      contest.post.deliveries.length === 0
    ) {
      // Неопубликованный конкурс отвечает так же, как несуществующий: знать
      // о его существовании постороннему незачем.
      throw new AppException(ErrorCode.NOT_FOUND, 'Конкурс не найден');
    }
    return contest;
  }

  private async findViewerEntry(
    contestId: string,
    externalUserId: string,
  ): Promise<{ id: string } | null> {
    return this.prisma.contestParticipant.findFirst({
      where: { contestId, platform: 'max', externalUserId },
      select: { id: true },
    });
  }

  private async winners(
    contestId: string,
    viewerParticipantId?: string,
  ): Promise<ContestWinnerView[]> {
    const prizes = await this.prisma.contestPrize.findMany({
      where: { contestId, winnerParticipantId: { not: null } },
      orderBy: { place: 'asc' },
      include: {
        winnerParticipant: {
          select: {
            id: true,
            displayName: true,
            platformUser: { select: { firstName: true, lastName: true } },
          },
        },
      },
    });

    return prizes.flatMap((prize) => {
      const winner = prize.winnerParticipant;
      if (!winner) return [];
      return [
        {
          place: prize.place,
          name: shortenName(
            winner.displayName,
            winner.platformUser?.firstName,
            winner.platformUser?.lastName,
          ),
          isMe: winner.id === viewerParticipantId,
        },
      ];
    });
  }
}
