import { Platform } from '../generated/prisma/client';
import { buildDedupKey, parseParticipantLines } from './contest-participants';

describe('buildDedupKey', () => {
  it('keys by platform id when there is one', () => {
    expect(
      buildDedupKey({
        platform: Platform.max,
        externalUserId: '42',
        externalUserIdKind: 'id',
        displayName: 'Иван',
      }),
    ).toBe('max:id:42');
  });

  it('does not collide ids across platforms', () => {
    const shared = {
      externalUserId: '42',
      externalUserIdKind: 'id' as const,
      displayName: 'Иван',
    };

    expect(buildDedupKey({ ...shared, platform: Platform.max })).not.toBe(
      buildDedupKey({ ...shared, platform: Platform.vk }),
    );
  });

  it('falls back to the name, ignoring case and stray spacing', () => {
    const key = buildDedupKey({
      platform: Platform.max,
      externalUserId: null,
      displayName: '  Иван   Иванов ',
    });

    expect(key).toBe('name:иван иванов');
    expect(
      buildDedupKey({
        platform: Platform.max,
        externalUserId: null,
        displayName: 'ИВАН ИВАНОВ',
      }),
    ).toBe(key);
  });

  it('keeps a handle apart from a numeric id', () => {
    // Ник и id — разные пространства имён, и платформа не даёт перевода
    // одного в другое. Склеивать их значило бы врать, что дедуп сработал.
    expect(
      buildDedupKey({
        platform: Platform.max,
        externalUserId: 'ivan',
        externalUserIdKind: 'handle',
        displayName: 'Иван',
      }),
    ).not.toBe(
      buildDedupKey({
        platform: Platform.max,
        externalUserId: 'ivan',
        externalUserIdKind: 'id',
        displayName: 'Иван',
      }),
    );
  });

  it('treats a handle as case-insensitive', () => {
    // Ники на обеих платформах регистронезависимы, так что @Nick и @nick —
    // один человек; иначе он попал бы в пул дважды.
    expect(
      buildDedupKey({
        platform: Platform.max,
        externalUserId: 'Nick',
        externalUserIdKind: 'handle',
        displayName: 'Ник',
      }),
    ).toBe(
      buildDedupKey({
        platform: Platform.max,
        externalUserId: 'nick',
        externalUserIdKind: 'handle',
        displayName: 'Ник',
      }),
    );
  });

  it('keeps a named entry apart from an identified one', () => {
    // Someone pasted by name and the same person pressing the button are not
    // automatically merged — nothing links the two, and silently merging on a
    // name match would be worse than leaving it to the admin's eye.
    expect(
      buildDedupKey({
        platform: Platform.max,
        externalUserId: null,
        displayName: 'Иван',
      }),
    ).not.toBe(
      buildDedupKey({
        platform: Platform.max,
        externalUserId: 'ivan',
        externalUserIdKind: 'handle',
        displayName: 'Иван',
      }),
    );
  });
});

describe('parseParticipantLines', () => {
  const parse = (text: string) => parseParticipantLines(text, Platform.max);

  it('reads a name with a numeric VK link', () => {
    expect(parse('Иван Иванов, vk.com/id123')).toEqual([
      {
        platform: Platform.vk,
        externalUserId: '123',
        externalUserIdKind: 'id',
        displayName: 'Иван Иванов',
        lineNumber: 1,
      },
    ]);
  });

  it('reads a VK screen name', () => {
    expect(parse('Пётр https://vk.com/durov')).toEqual([
      {
        platform: Platform.vk,
        externalUserId: 'durov',
        externalUserIdKind: 'handle',
        displayName: 'Пётр',
        lineNumber: 1,
      },
    ]);
  });

  it('reads a MAX handle', () => {
    expect(parse('Мария @maria_max')).toEqual([
      {
        platform: Platform.max,
        externalUserId: 'maria_max',
        externalUserIdKind: 'handle',
        displayName: 'Мария',
        lineNumber: 1,
      },
    ]);
  });

  it('keeps a line with no link as a name-only participant', () => {
    // Allowed on purpose: such a participant simply cannot be notified
    // automatically, which the notification status then makes visible.
    expect(parse('Анна Смирнова')).toEqual([
      {
        platform: Platform.max,
        externalUserId: null,
        displayName: 'Анна Смирнова',
        lineNumber: 1,
      },
    ]);
  });

  it('skips blank lines but keeps the original line numbers', () => {
    const result = parse('Иван @ivan\n\n   \nМария @maria');

    expect(result.map((r) => r.lineNumber)).toEqual([1, 4]);
  });

  it('prefers the numeric VK id over reading the link as a screen name', () => {
    expect(parse('vk.com/id77')[0]).toMatchObject({
      externalUserId: '77',
      platform: Platform.vk,
    });
  });

  it('does not leave an empty name when the line is just a link', () => {
    const [entry] = parse('vk.com/id77');

    expect(entry.displayName).not.toBe('');
  });

  it('does not mistake an email-looking line for a MAX handle', () => {
    // The handle pattern requires the @ to start a word; without that guard
    // "ivan@example.com" would register as the handle "example".
    expect(parse('ivan@example.com')[0]).toMatchObject({
      externalUserId: null,
    });
  });
});
