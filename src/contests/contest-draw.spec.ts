import {
  ContestDrawError,
  drawWinners,
  generateSeed,
  type DrawPrizeInput,
} from './contest-draw';

const SEED_A = 'a'.repeat(64);
const SEED_B = 'b'.repeat(64);

const prize = (place: number, forced?: string): DrawPrizeInput => ({
  id: `prize-${place}`,
  place,
  forcedWinnerParticipantId: forced ?? null,
});

const participants = (count: number) =>
  Array.from({ length: count }, (_, i) => `p${String(i).padStart(3, '0')}`);

/** Asserts both the error type and its code, which is what callers branch on. */
const expectDrawError = (
  run: () => unknown,
  code: ContestDrawError['code'],
) => {
  expect(run).toThrow(ContestDrawError);
  try {
    run();
  } catch (error) {
    expect((error as ContestDrawError).code).toBe(code);
  }
};

describe('drawWinners', () => {
  it('gives the same result for the same seed', () => {
    const input = {
      participantIds: participants(50),
      prizes: [prize(1), prize(2), prize(3)],
      seed: SEED_A,
    };

    // The whole point of seeding: a disputed draw can be recomputed from the
    // log and shown to produce exactly the recorded winners.
    expect(drawWinners(input)).toEqual(drawWinners(input));
  });

  it('gives a different result for a different seed', () => {
    const base = { participantIds: participants(50), prizes: [prize(1)] };

    expect(drawWinners({ ...base, seed: SEED_A })).not.toEqual(
      drawWinners({ ...base, seed: SEED_B }),
    );
  });

  it('does not depend on the order the participants arrive in', () => {
    const ids = participants(30);
    const shuffled = [...ids].reverse();

    // Rows come back from Postgres in no guaranteed order, so a draw that
    // depended on it would be unreproducible in practice while looking
    // perfectly deterministic in a test.
    expect(
      drawWinners({
        participantIds: ids,
        prizes: [prize(1), prize(2)],
        seed: SEED_A,
      }),
    ).toEqual(
      drawWinners({
        participantIds: shuffled,
        prizes: [prize(1), prize(2)],
        seed: SEED_A,
      }),
    );
  });

  it('does not depend on the order the prizes arrive in', () => {
    const ids = participants(30);

    expect(
      drawWinners({
        participantIds: ids,
        prizes: [prize(1), prize(2)],
        seed: SEED_A,
      }),
    ).toEqual(
      drawWinners({
        participantIds: ids,
        prizes: [prize(2), prize(1)],
        seed: SEED_A,
      }),
    );
  });

  it('never gives one participant two places', () => {
    const result = drawWinners({
      participantIds: participants(5),
      prizes: [prize(1), prize(2), prize(3), prize(4), prize(5)],
      seed: SEED_A,
    });
    const winners = result.map((r) => r.participantId);

    expect(new Set(winners).size).toBe(5);
  });

  it('assigns forced places as given and draws the rest around them', () => {
    const result = drawWinners({
      participantIds: participants(10),
      prizes: [prize(1, 'p007'), prize(2), prize(3)],
      seed: SEED_A,
    });

    expect(result[0]).toEqual({
      prizeId: 'prize-1',
      place: 1,
      participantId: 'p007',
      isForced: true,
    });
    // A forced winner is out of the pool, so they cannot also be drawn for
    // another place.
    expect(result.slice(1).map((r) => r.participantId)).not.toContain('p007');
    expect(result.slice(1).every((r) => !r.isForced)).toBe(true);
  });

  it('refuses a draw with fewer participants than open places', () => {
    expect(() =>
      drawWinners({
        participantIds: participants(2),
        prizes: [prize(1), prize(2), prize(3)],
        seed: SEED_A,
      }),
    ).toThrow(ContestDrawError);
  });

  it('counts forced places as filled when checking participant count', () => {
    // Two participants and three places is normally too few, but one place is
    // already forced, so only two are actually drawn.
    expect(() =>
      drawWinners({
        participantIds: participants(3),
        prizes: [prize(1, 'p000'), prize(2), prize(3)],
        seed: SEED_A,
      }),
    ).not.toThrow();
  });

  it('rejects a forced winner who is not a participant', () => {
    expectDrawError(
      () =>
        drawWinners({
          participantIds: participants(5),
          prizes: [prize(1, 'stranger')],
          seed: SEED_A,
        }),
      'FORCED_WINNER_NOT_PARTICIPANT',
    );
  });

  it('rejects the same participant forced onto two places', () => {
    expectDrawError(
      () =>
        drawWinners({
          participantIds: participants(5),
          prizes: [prize(1, 'p001'), prize(2, 'p001')],
          seed: SEED_A,
        }),
      'FORCED_WINNER_DUPLICATED',
    );
  });

  it('rejects a contest with no prizes', () => {
    expectDrawError(
      () =>
        drawWinners({
          participantIds: participants(5),
          prizes: [],
          seed: SEED_A,
        }),
      'NO_PRIZES',
    );
  });

  it('ignores duplicate participant ids rather than giving anyone two tickets', () => {
    const result = drawWinners({
      participantIds: ['p1', 'p1', 'p2'],
      prizes: [prize(1), prize(2)],
      seed: SEED_A,
    });

    expect(new Set(result.map((r) => r.participantId))).toEqual(
      new Set(['p1', 'p2']),
    );
  });

  it('spreads winners across the pool rather than favouring an end of it', () => {
    // A modulo-biased or otherwise skewed generator would still pass the
    // determinism tests above, so check the distribution directly: over many
    // single-prize draws every participant should come up sometimes.
    const ids = participants(10);
    const seen = new Set<string>();
    for (let i = 0; i < 300; i += 1) {
      const [winner] = drawWinners({
        participantIds: ids,
        prizes: [prize(1)],
        seed: generateSeed(),
      });
      seen.add(winner.participantId);
    }

    expect(seen.size).toBe(ids.length);
  });
});

describe('generateSeed', () => {
  it('produces a fresh 32-byte hex seed', () => {
    const seed = generateSeed();

    expect(seed).toMatch(/^[0-9a-f]{64}$/);
    expect(generateSeed()).not.toBe(seed);
  });
});
