import { createHmac, randomBytes } from 'node:crypto';

/**
 * Розыгрыш должен быть не просто честным, а *доказуемо* честным: участник,
 * оспоривший результат, вправе потребовать пересчёта. Поэтому случайность
 * берётся не напрямую из `crypto.randomInt`, а из одного криптостойкого сида:
 * сид пишется в `ContestDrawLog`, и по нему тот же список участников даёт тот
 * же результат. Снапшот результата доказывает только «что получилось», сид —
 * «что это посчиталось именно так».
 */

const SEED_BYTES = 32;

export function generateSeed(): string {
  return randomBytes(SEED_BYTES).toString('hex');
}

/**
 * Детерминированный источник случайных чисел из сида. HMAC-SHA256 по
 * счётчику: поток неотличим от случайного, но полностью воспроизводим.
 */
class SeededRandom {
  private block = Buffer.alloc(0);
  private offset = 0;
  private counter = 0;

  constructor(private readonly seed: Buffer) {}

  private refill(): void {
    const counterBuf = Buffer.alloc(8);
    counterBuf.writeBigUInt64BE(BigInt(this.counter));
    this.counter += 1;
    this.block = createHmac('sha256', this.seed).update(counterBuf).digest();
    this.offset = 0;
  }

  private nextUint32(): number {
    if (this.offset + 4 > this.block.length) {
      this.refill();
    }
    const value = this.block.readUInt32BE(this.offset);
    this.offset += 4;
    return value;
  }

  /**
   * Равномерное целое в [0, maxExclusive). Значения из «хвоста», который не
   * делится на диапазон нацело, отбрасываются — иначе младшие элементы
   * получали бы чуть больший шанс, а для розыгрыша это и есть подкрутка,
   * пусть и непреднамеренная.
   */
  nextInt(maxExclusive: number): number {
    if (maxExclusive <= 0) {
      throw new RangeError('maxExclusive must be positive');
    }
    const limit = Math.floor(0x1_0000_0000 / maxExclusive) * maxExclusive;
    let value = this.nextUint32();
    while (value >= limit) {
      value = this.nextUint32();
    }
    return value % maxExclusive;
  }
}

export interface DrawPrizeInput {
  id: string;
  place: number;
  /** Победитель, назначенный вручную («подкрутка»), — разыгрывать не нужно. */
  forcedWinnerParticipantId?: string | null;
}

export interface DrawInput {
  /** Идентификаторы участников общего пула конкурса. */
  participantIds: string[];
  prizes: DrawPrizeInput[];
  seed: string;
}

export interface DrawAssignment {
  prizeId: string;
  place: number;
  participantId: string;
  isForced: boolean;
}

export class ContestDrawError extends Error {
  constructor(
    readonly code:
      | 'NOT_ENOUGH_PARTICIPANTS'
      | 'FORCED_WINNER_NOT_PARTICIPANT'
      | 'FORCED_WINNER_DUPLICATED'
      | 'NO_PRIZES',
    message: string,
  ) {
    super(message);
    this.name = 'ContestDrawError';
  }
}

/**
 * Разыгрывает все места разом: форсированные просто назначаются, остальные
 * тянутся из пула за вычетом уже занятых. Один участник не может занять два
 * места, поэтому выигравший немедленно выбывает из пула.
 *
 * Функция намеренно чистая: ни обращений к БД, ни времени, ни глобального
 * `crypto` — только вход и сид. Иначе пересчёт розыгрыша был бы невозможен.
 */
export function drawWinners({
  participantIds,
  prizes,
  seed,
}: DrawInput): DrawAssignment[] {
  if (prizes.length === 0) {
    throw new ContestDrawError('NO_PRIZES', 'У конкурса нет призовых мест');
  }

  const participants = new Set(participantIds);
  const forcedSeen = new Set<string>();

  for (const prize of prizes) {
    const forced = prize.forcedWinnerParticipantId;
    if (!forced) continue;
    if (!participants.has(forced)) {
      throw new ContestDrawError(
        'FORCED_WINNER_NOT_PARTICIPANT',
        `Назначенный на место ${prize.place} победитель не участвует в конкурсе`,
      );
    }
    if (forcedSeen.has(forced)) {
      throw new ContestDrawError(
        'FORCED_WINNER_DUPLICATED',
        'Один участник назначен на несколько мест',
      );
    }
    forcedSeen.add(forced);
  }

  // Порядок пула обязан быть детерминированным, иначе один и тот же сид дал
  // бы разный результат: сортировка важнее, чем кажется.
  const pool = [...participants].filter((id) => !forcedSeen.has(id)).sort();
  const openPrizes = prizes.filter((p) => !p.forcedWinnerParticipantId);

  if (pool.length < openPrizes.length) {
    throw new ContestDrawError(
      'NOT_ENOUGH_PARTICIPANTS',
      `Участников (${pool.length}) меньше, чем разыгрываемых мест (${openPrizes.length})`,
    );
  }

  const random = new SeededRandom(Buffer.from(seed, 'hex'));
  // Места разыгрываются по возрастанию, чтобы пересчёт по сиду совпал
  // независимо от того, в каком порядке места пришли из базы.
  const ordered = [...prizes].sort((a, b) => a.place - b.place);

  return ordered.map((prize) => {
    const forced = prize.forcedWinnerParticipantId;
    if (forced) {
      return {
        prizeId: prize.id,
        place: prize.place,
        participantId: forced,
        isForced: true,
      };
    }
    const index = random.nextInt(pool.length);
    const [winner] = pool.splice(index, 1);
    return {
      prizeId: prize.id,
      place: prize.place,
      participantId: winner,
      isForced: false,
    };
  });
}
