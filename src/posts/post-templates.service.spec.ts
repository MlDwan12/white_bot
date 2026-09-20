import { ConfigService } from '@nestjs/config';
import { PinoLogger } from 'nestjs-pino';
import { AppException } from '../common/app-exception';
import { PrismaService } from '../prisma/prisma.service';
import { Post } from '../generated/prisma/client';
import { PostsService } from './posts.service';
import { PostTemplatesService } from './post-templates.service';

function template(overrides: Partial<Post> = {}): Post {
  return {
    id: 'tpl-1',
    text: 'повторяющийся текст',
    vkTextOverride: null,
    maxTextOverride: null,
    recurrenceRule: '0 10 * * *',
    timezone: 'Europe/Moscow',
    // Relative to the run, not a fixed date: a window is only published within
    // LATE_WINDOW_GRACE_MS of its time, so a hard-coded past date would make
    // every firing test exercise the stale-window skip instead.
    nextRunAt: new Date(Date.now() - 60_000),
    templatePaused: false,
    status: 'draft',
    stopRequested: false,
    ...overrides,
  } as Post;
}

/** Reads one argument of a recorded call as `T`. */
function callArg<T>(mockFn: jest.Mock, callIndex: number, argIndex: number): T {
  const calls = mockFn.mock.calls as unknown[][];
  return calls[callIndex][argIndex] as T;
}

function setup() {
  /**
   * `fireTemplate` re-reads the template, its targets and its attachments in
   * one query, so the mock has to answer that shape when `include` is asked
   * for — and the plain row otherwise (findTemplateOrThrow).
   */
  const templateRow = { current: template() };
  const targets = { current: [] as ReturnType<typeof target>[] };
  const attachments = { current: [] as { mediaAssetId: string }[] };

  const prisma = {
    post: {
      findUnique: jest
        .fn()
        .mockImplementation(({ include }: { include?: unknown }) =>
          Promise.resolve(
            include
              ? {
                  ...templateRow.current,
                  templateTargets: targets.current,
                  attachments: attachments.current,
                }
              : templateRow.current,
          ),
        ),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({ id: 'occ-1' }),
      update: jest
        .fn()
        .mockImplementation(({ data }: { data: object }) =>
          Promise.resolve(template(data as Partial<Post>)),
        ),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    postTemplateTarget: {
      findMany: jest.fn().mockResolvedValue([]),
      deleteMany: jest.fn(),
      createMany: jest.fn(),
    },
    // Templates tolerate an inactive target (unlike a one-off post) but not one
    // that was never confirmed; the mock answers with whatever the test asked
    // for, defaulting to a group that has gone inactive and may recover.
    group: {
      findMany: jest
        .fn()
        .mockImplementation(({ where }: { where: { id: { in: string[] } } }) =>
          Promise.resolve(
            where.id.in.map((id) => ({
              id,
              status: 'token_invalid',
              title: id,
            })),
          ),
        ),
    },
    postAttachment: {
      findMany: jest.fn().mockResolvedValue([]),
      deleteMany: jest.fn(),
      createMany: jest.fn(),
    },
    mediaAsset: { count: jest.fn().mockResolvedValue(0) },
    // Resolves the operations it is handed, so a test can read what the
    // transaction actually returned (updateTemplate takes the template row
    // out of it).
    $transaction: jest.fn(),
  };
  // Two shapes: an array of operations (updateTemplate) and an interactive
  // callback (the REPEATABLE READ re-read in fireTemplate). Wired after the
  // object exists so the callback can be handed the same mock.
  prisma.$transaction.mockImplementation((arg: unknown) =>
    typeof arg === 'function'
      ? (arg as (tx: typeof prisma) => unknown)(prisma)
      : Promise.all(arg as unknown[]),
  );

  const posts = {
    enqueueDispatch: jest.fn().mockResolvedValue(undefined),
    assertAttachmentsUsable: jest.fn().mockResolvedValue(undefined),
    assertGroupsUsable: jest.fn().mockResolvedValue(undefined),
    // Answers with every VK group it is asked about — the healthy token case.
    publishableVkGroups: jest
      .fn()
      .mockImplementation((_assets: string[], groupIds: string[]) =>
        Promise.resolve(groupIds),
      ),
  };
  const config = {
    getOrThrow: () => 'Europe/Moscow',
  } as unknown as ConfigService;
  const logger = {
    setContext: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };

  const service = new PostTemplatesService(
    prisma as unknown as PrismaService,
    posts as unknown as PostsService,
    config,
    logger as unknown as PinoLogger,
  );
  /** Sets what the template read returns, for both shapes at once. */
  const given = (opts: {
    row?: Post;
    targets?: ReturnType<typeof target>[];
    attachments?: { mediaAssetId: string }[];
  }) => {
    if (opts.row) {
      templateRow.current = opts.row;
    }
    if (opts.targets) targets.current = opts.targets;
    if (opts.attachments) attachments.current = opts.attachments;
    // The sweep must find this template due, whichever part the test set.
    prisma.post.findMany.mockResolvedValue([templateRow.current]);
  };

  return { service, prisma, posts, logger, given };
}

/** An active target row as the include shape returns it. */
function target(groupId: string, status = 'active', platform = 'vk') {
  return {
    groupId,
    group: { id: groupId, status, title: groupId, platform },
  };
}

describe('PostTemplatesService', () => {
  describe('createTemplate', () => {
    it('rejects blank text before storing anything', async () => {
      // Каждое срабатывание рождало бы пост, который VK и MAX отвергают.
      // Панель не проходит валидацию DTO, поэтому проверка живёт в сервисе.
      const { service, prisma } = setup();

      for (const text of ['', '   ', '\n\t']) {
        await expect(
          service.createTemplate({
            text,
            recurrenceRule: '0 10 * * *',
            groupIds: ['g1'],
          }),
        ).rejects.toBeInstanceOf(AppException);
      }
      expect(prisma.post.create).not.toHaveBeenCalled();
    });

    it('rejects an invalid schedule before storing anything', async () => {
      const { service, prisma } = setup();

      await expect(
        service.createTemplate({
          text: 'x',
          recurrenceRule: 'не cron',
          groupIds: ['g1'],
        }),
      ).rejects.toBeInstanceOf(AppException);
      expect(prisma.post.create).not.toHaveBeenCalled();
    });

    it('stores the timezone on the template rather than reading it later', async () => {
      const { service, prisma } = setup();

      await service.createTemplate({
        text: 'x',
        recurrenceRule: '0 10 * * *',
        groupIds: ['g1'],
      });

      // Copied at creation so that changing DEFAULT_TIMEZONE later cannot
      // silently move the firing time of templates that already exist.
      const data = callArg<{ data: { timezone: string; nextRunAt: Date } }>(
        prisma.post.create,
        0,
        0,
      ).data;
      expect(data.timezone).toBe('Europe/Moscow');
      expect(data.nextRunAt).toBeInstanceOf(Date);
    });

    it('puts targets in the template list, not in deliveries', async () => {
      const { service, prisma } = setup();

      await service.createTemplate({
        text: 'x',
        recurrenceRule: '0 10 * * *',
        groupIds: ['g1', 'g2'],
      });

      // A template never delivers anything itself; its targets are an
      // editable list, and each firing turns them into a child post's
      // deliveries.
      const data = callArg<{
        data: { templateTargets: { create: unknown[] }; deliveries?: unknown };
      }>(prisma.post.create, 0, 0).data;
      expect(data.templateTargets.create).toHaveLength(2);
      expect(data.deliveries).toBeUndefined();
    });
  });

  describe('fireDueTemplates', () => {
    it('claims the window before creating anything', async () => {
      const { service, prisma, given } = setup();
      const tpl = template();
      given({ row: tpl, targets: [target('g1')] });

      await service.fireDueTemplates(new Date('2026-09-18T07:00:00.000Z'));

      // Conditional on nextRunAt still holding the value we read, so two
      // sweeps racing cannot both fire the same window.
      const claim = callArg<{ where: { nextRunAt: Date } }>(
        prisma.post.updateMany,
        0,
        0,
      );
      expect(claim.where.nextRunAt).toBe(tpl.nextRunAt);
    });

    it('creates nothing when another sweep already took the window', async () => {
      const { service, prisma } = setup();
      prisma.post.findMany.mockResolvedValue([template()]);
      prisma.post.updateMany.mockResolvedValue({ count: 0 });

      const fired = await service.fireDueTemplates();

      expect(fired).toBe(0);
      expect(prisma.post.create).not.toHaveBeenCalled();
    });

    it('snapshots text, targets and attachments into the child post', async () => {
      const { service, prisma, posts, given } = setup();
      given({
        row: template({ text: 'снимок' }),
        targets: [target('g1'), target('g2')],
        attachments: [{ mediaAssetId: 'm1' }, { mediaAssetId: 'm2' }],
      });

      await service.fireDueTemplates();

      const data = callArg<{
        data: {
          text: string;
          recurringTemplateId: string;
          recurrenceRule?: string;
          status: string;
          deliveries: { create: { groupId: string }[] };
          attachments: { create: { mediaAssetId: string; position: number }[] };
        };
      }>(prisma.post.create, 0, 0).data;

      expect(data.text).toBe('снимок');
      expect(data.recurringTemplateId).toBe('tpl-1');
      // The occurrence must not itself look like a template, or it would be
      // fired again as one.
      expect(data.recurrenceRule).toBeUndefined();
      expect(data.status).toBe('scheduled');
      expect(data.deliveries.create).toEqual([
        { groupId: 'g1' },
        { groupId: 'g2' },
      ]);
      expect(data.attachments.create).toEqual([
        { mediaAssetId: 'm1', position: 0 },
        { mediaAssetId: 'm2', position: 1 },
      ]);
      expect(posts.enqueueDispatch).toHaveBeenCalled();
    });

    it('leaves out a target that is no longer deliverable', async () => {
      const { service, prisma, logger, given } = setup();
      given({ targets: [target('g1'), target('g2', 'bot_removed')] });

      await service.fireDueTemplates();

      // Dropping one dead group beats cancelling the whole firing; the
      // template keeps it in case the group comes back.
      const data = callArg<{ data: { deliveries: { create: unknown[] } } }>(
        prisma.post.create,
        0,
        0,
      ).data;
      expect(data.deliveries.create).toEqual([{ groupId: 'g1' }]);
      expect(logger.warn).toHaveBeenCalled();
    });

    it('skips the firing entirely when no target can receive it', async () => {
      const { service, prisma, given } = setup();
      given({ targets: [target('g1', 'bot_removed')] });

      const fired = await service.fireDueTemplates();

      // An occurrence with zero deliveries would immediately settle as `sent`
      // and claim a success that never happened.
      expect(fired).toBe(0);
      expect(prisma.post.create).not.toHaveBeenCalled();
    });

    it('snapshots text and targets from one read, not from the stale sweep copy', async () => {
      const { service, prisma, given } = setup();
      given({ targets: [target('g1')] });
      // The sweep saw the old text; the edit committed before this firing read
      // the row back. Reading text separately from targets could pair the old
      // text with the new target list — the torn state updateTemplate's
      // transaction exists to prevent, moved to the read side.
      prisma.post.findMany.mockResolvedValue([template({ text: 'старый' })]);
      prisma.post.findUnique.mockImplementation(
        ({ include }: { include?: unknown }) =>
          Promise.resolve(
            include
              ? {
                  ...template({ text: 'новый' }),
                  templateTargets: [target('g1')],
                  attachments: [],
                }
              : template({ text: 'новый' }),
          ),
      );

      await service.fireDueTemplates();

      const data = callArg<{ data: { text: string } }>(
        prisma.post.create,
        0,
        0,
      ).data;
      expect(data.text).toBe('новый');
    });

    it('re-reads the template at REPEATABLE READ', async () => {
      const { service, prisma, given } = setup();
      given({ targets: [target('g1')] });

      await service.fireDueTemplates();

      // `include` is four separate SELECTs; under READ COMMITTED each gets its
      // own snapshot, so an edit landing between them tears the occurrence.
      const opts = callArg<{ isolationLevel: string }>(
        prisma.$transaction,
        0,
        1,
      );
      expect(opts.isolationLevel).toBe('RepeatableRead');
    });

    it('does not charge a template for how long the sweep took to reach it', async () => {
      const { service, prisma, given } = setup();
      // Window came due two minutes before the sweep started — well inside the
      // grace bound — but the recovery passes ahead of it ran for half an hour.
      const sweepStartedAt = new Date(Date.now() - 30 * 60 * 1000);
      given({
        row: template({
          nextRunAt: new Date(sweepStartedAt.getTime() - 2 * 60 * 1000),
        }),
        targets: [target('g1')],
      });

      const fired = await service.fireDueTemplates(sweepStartedAt);

      // Measured from the per-template clock instead, this window looks 32
      // minutes stale and the day's post is dropped with only a warn.
      expect(fired).toBe(1);
      expect(prisma.post.create).toHaveBeenCalled();
    });

    it('abandons a window the app slept through instead of publishing it late', async () => {
      const { service, prisma, given, logger } = setup();
      // Daily 10:00 template, app down for two days.
      given({
        row: template({
          nextRunAt: new Date(Date.now() - 20 * 60 * 60 * 1000),
        }),
        targets: [target('g1')],
      });

      const fired = await service.fireDueTemplates();

      // Publishing it on recovery puts an occurrence an hour off schedule right
      // next to the genuine window that follows — two posts on walls
      // wall.delete cannot clean up.
      expect(fired).toBe(0);
      expect(prisma.post.create).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalled();
      // The window is still moved on, under the same conditional claim, so a
      // concurrent sweep cannot publish what this one abandoned.
      const claim = callArg<{
        where: { nextRunAt: Date };
        data: { nextRunAt: Date };
      }>(prisma.post.updateMany, 0, 0);
      expect(claim.data.nextRunAt.getTime()).toBeGreaterThan(Date.now());
    });

    it('still publishes a window that is merely a little late', async () => {
      const { service, prisma, given } = setup();
      // A restart costs a minute or two; that must not lose the post.
      given({
        row: template({ nextRunAt: new Date(Date.now() - 3 * 60 * 1000) }),
        targets: [target('g1')],
      });

      const fired = await service.fireDueTemplates();

      expect(fired).toBe(1);
      expect(prisma.post.create).toHaveBeenCalled();
    });

    it('disarms a stale template whose rule no longer parses', async () => {
      const { service, prisma, logger, given } = setup();
      // Both conditions at once: the window is long past *and* the stored rule
      // is unreadable. The stale path used to compute the next window without
      // the disarm, so it threw, nextRunAt never moved, and the sweep repeated
      // this once a minute forever while getTemplate still said `running`.
      given({
        row: template({
          recurrenceRule: 'не cron',
          nextRunAt: new Date(Date.now() - 20 * 60 * 60 * 1000),
        }),
      });

      const fired = await service.fireDueTemplates();

      expect(fired).toBe(0);
      const clear = callArg<{ data: { nextRunAt: Date | null } }>(
        prisma.post.updateMany,
        0,
        0,
      );
      expect(clear.data.nextRunAt).toBeNull();
      expect(logger.error).toHaveBeenCalled();
    });

    it('computes the next window from a clock read per template', async () => {
      const { service, prisma, given } = setup();
      given({
        row: template({ recurrenceRule: '* * * * *' }),
        targets: [target('g1')],
      });
      // The sweep's own timestamp, already minutes old by the time the loop
      // reaches this template — a long recovery backlog ahead of it.
      const sweepStartedAt = new Date(Date.now() - 5 * 60 * 1000);

      await service.fireDueTemplates(sweepStartedAt);

      // Computed from that stale timestamp, the new window lands in the *past*,
      // so the next sweep fires this template again inside the same window —
      // a replayed window, on walls wall.delete cannot clean up.
      const claim = callArg<{ data: { nextRunAt: Date } }>(
        prisma.post.updateMany,
        0,
        0,
      );
      expect(claim.data.nextRunAt.getTime()).toBeGreaterThan(Date.now());
    });

    it('keeps going when one template fails', async () => {
      const { service, prisma, logger, given } = setup();
      given({ targets: [target('g1')] });
      prisma.post.findMany.mockResolvedValue([
        template({ id: 'tpl-1' }),
        template({ id: 'tpl-2' }),
      ]);
      prisma.post.create
        .mockRejectedValueOnce(new Error('БД недоступна'))
        .mockResolvedValueOnce({ id: 'occ-2' });

      const fired = await service.fireDueTemplates();

      expect(fired).toBe(1);
      expect(logger.error).toHaveBeenCalled();
    });

    it('skips the firing when the VK uploader token cannot upload the attachments', async () => {
      const { service, prisma, posts, logger, given } = setup();
      // VK-only: nothing this firing could reach works without the token.
      given({
        targets: [target('g1', 'active', 'vk')],
        attachments: [{ mediaAssetId: 'm1' }],
      });
      posts.publishableVkGroups.mockResolvedValue([]);

      const fired = await service.fireDueTemplates();

      // Creating the occurrence anyway would park it in `scheduled`, and every
      // further firing would park another — until re-authorization released
      // all of them into real communities at once.
      expect(fired).toBe(0);
      expect(prisma.post.create).not.toHaveBeenCalled();
      expect(posts.enqueueDispatch).not.toHaveBeenCalled();
      expect(logger.error).toHaveBeenCalled();
      // The window is still consumed, not retried: missed windows are never
      // replayed.
      expect(prisma.post.updateMany).toHaveBeenCalled();
    });

    it('still publishes to MAX when the VK token is dead', async () => {
      const { service, prisma, posts, given } = setup();
      given({
        targets: [
          target('g-vk', 'active', 'vk'),
          target('g-max', 'active', 'max'),
        ],
        attachments: [{ mediaAssetId: 'm1' }],
      });
      posts.publishableVkGroups.mockResolvedValue([]);

      const fired = await service.fireDueTemplates();

      // MAX uploads use the bot token, so cancelling the whole firing lost
      // those posts too — and the window is already consumed, so unlike a
      // one-off campaign there is nothing to re-offer them from.
      expect(fired).toBe(1);
      const data = callArg<{
        data: { deliveries: { create: { groupId: string }[] } };
      }>(prisma.post.create, 0, 0).data;
      expect(data.deliveries.create).toEqual([{ groupId: 'g-max' }]);
    });

    it('asks about VK groups only — MAX uploads use the bot token', async () => {
      const { service, posts, given } = setup();
      given({
        targets: [target('g1', 'active', 'vk'), target('g2', 'active', 'max')],
        attachments: [{ mediaAssetId: 'm1' }],
      });

      await service.fireDueTemplates();

      expect(posts.publishableVkGroups).toHaveBeenCalledWith(['m1'], ['g1']);
    });

    it('keeps the VK groups whose files are already uploaded', async () => {
      const { service, prisma, posts, given } = setup();
      given({
        targets: [
          target('g-old', 'active', 'vk'),
          target('g-new', 'active', 'vk'),
        ],
        attachments: [{ mediaAssetId: 'm1' }],
      });
      // A month-old template: g-old has the file cached, g-new was just added
      // and the personal token is expired (the normal steady state).
      posts.publishableVkGroups.mockResolvedValue(['g-old']);

      const fired = await service.fireDueTemplates();

      // Dropping the whole VK set would lose a post that needed no token at
      // all, and the window is already claimed — so it would be gone for good.
      expect(fired).toBe(1);
      const data = callArg<{
        data: { deliveries: { create: { groupId: string }[] } };
      }>(prisma.post.create, 0, 0).data;
      expect(data.deliveries.create).toEqual([{ groupId: 'g-old' }]);
    });

    it('stops a template whose stored schedule no longer parses', async () => {
      const { service, prisma, logger, given } = setup();
      given({ row: template({ recurrenceRule: 'не cron' }) });

      const fired = await service.fireDueTemplates();

      // Left as it was, nextRunAt would never move and the sweep would re-try
      // and re-log this template once a minute forever.
      expect(fired).toBe(0);
      const clear = callArg<{
        where: { templatePaused: boolean };
        data: { nextRunAt: Date | null; templatePaused?: boolean };
      }>(prisma.post.updateMany, 0, 0);
      expect(clear.data.nextRunAt).toBeNull();
      // Claimed on `templatePaused: false` like its two siblings: a pause
      // landing between the sweep's findMany and this write would otherwise
      // leave the row paused *and* disarmed, and getTemplate checks `paused`
      // first — hiding the unreadable rule behind a state the admin chose.
      expect(clear.where.templatePaused).toBe(false);
      // Deliberately *not* paused: pausing is the admin's switch, and faking it
      // here would misreport who stopped the template and force a two-step
      // recovery. `nextRunAt: null` alone means disarmed.
      expect(clear.data.templatePaused).toBeUndefined();
      expect(logger.error).toHaveBeenCalled();
    });

    it('bounds how many templates one sweep fires, oldest window first', async () => {
      const { service, prisma } = setup();

      await service.fireDueTemplates();

      // Unbounded, the first sweep after an outage can outlive the
      // reconciler's 30s lock, which is never refreshed — a second instance
      // then sweeps alongside, which the lock exists to prevent.
      const query = callArg<{ take: number; orderBy: { nextRunAt: string } }>(
        prisma.post.findMany,
        0,
        0,
      );
      expect(query.take).toBeGreaterThan(0);
      expect(query.orderBy).toEqual({ nextRunAt: 'asc' });
    });

    it('only looks at templates that are due and not paused', async () => {
      const { service, prisma } = setup();
      const now = new Date('2026-09-18T07:00:00.000Z');

      await service.fireDueTemplates(now);

      const where = callArg<{ where: Record<string, unknown> }>(
        prisma.post.findMany,
        0,
        0,
      ).where;
      expect(where).toMatchObject({
        recurrenceRule: { not: null },
        templatePaused: false,
        nextRunAt: { lte: now },
      });
    });
  });

  describe('updateTemplate', () => {
    it('rejects blank text but lets an edit without text through', async () => {
      const { service, prisma } = setup();

      await expect(
        service.updateTemplate('tpl-1', { text: '   ' }),
      ).rejects.toBeInstanceOf(AppException);
      expect(prisma.post.update).not.toHaveBeenCalled();

      // Поле не передано — «не трогать», а не «стереть».
      await expect(
        service.updateTemplate('tpl-1', { groupIds: ['g1'] }),
      ).resolves.toBeDefined();
    });

    it('replaces the target list and the template row in one transaction', async () => {
      const { service, prisma } = setup();

      await service.updateTemplate('tpl-1', {
        text: 'новый текст',
        groupIds: ['g1', 'g2'],
      });

      // Committed separately, a failing template update returned an error
      // implying nothing had changed while the new target list was already
      // live — the next firing would go to the new groups with the old text.
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      const ops = callArg<unknown[]>(prisma.$transaction, 0, 0);
      expect(ops).toHaveLength(3);
      expect(prisma.postTemplateTarget.deleteMany).toHaveBeenCalled();
      expect(prisma.postTemplateTarget.createMany).toHaveBeenCalled();
      expect(prisma.post.update).toHaveBeenCalled();
    });

    it('writes the resolved timezone, not the raw input', async () => {
      const { service, prisma } = setup();
      // A template whose timezone column is still NULL.
      prisma.post.findUnique.mockResolvedValue(template({ timezone: null }));

      await service.updateTemplate('tpl-1', { recurrenceRule: '0 9 * * *' });

      // Left as `input.timezone`, the column stayed NULL while nextRunAt was
      // already computed from DEFAULT_TIMEZONE — so changing that env var later
      // would move "every day at 09:00", which storing the zone exists to stop.
      const data = callArg<{ data: { timezone?: string } }>(
        prisma.post.update,
        0,
        0,
      ).data;
      expect(data.timezone).toBe('Europe/Moscow');
    });

    it('replaces the attachment list when the edit mentions it', async () => {
      const { service, prisma } = setup();

      await service.updateTemplate('tpl-1', { attachmentIds: ['m2', 'm1'] });

      // Without attachmentIds on the DTO, a panel PATCH changing attachments
      // answered 200 and changed nothing.
      const ops = callArg<unknown[]>(prisma.$transaction, 0, 0);
      expect(ops).toHaveLength(3);
      expect(prisma.postAttachment.deleteMany).toHaveBeenCalled();
      const created = callArg<{
        data: { mediaAssetId: string; position: number }[];
      }>(prisma.postAttachment.createMany, 0, 0).data;
      // Position follows the new order — it decides how VK shows them.
      expect(created).toEqual([
        { postId: 'tpl-1', mediaAssetId: 'm2', position: 0 },
        { postId: 'tpl-1', mediaAssetId: 'm1', position: 1 },
      ]);
    });

    it('arms a disarmed template on any edit, not just a schedule change', async () => {
      const { service, prisma } = setup();
      prisma.post.findUnique.mockResolvedValue(template({ nextRunAt: null }));

      // Only the text changes — with the old `scheduleChanged`-only rule this
      // template stayed dead, contradicting what the migration promises.
      await service.updateTemplate('tpl-1', { text: 'правка' });

      const data = callArg<{ data: { nextRunAt?: Date } }>(
        prisma.post.update,
        0,
        0,
      ).data;
      expect(data.nextRunAt).toBeInstanceOf(Date);
    });

    it('accepts a target list that still contains an inactive group', async () => {
      const { service, prisma, posts } = setup();

      await service.updateTemplate('tpl-1', { groupIds: ['g1', 'g2'] });

      // The firing path skips an inactive target and keeps it in case the group
      // recovers; rejecting the edit here would force the admin to drop it just
      // to add another group.
      expect(posts.assertGroupsUsable).not.toHaveBeenCalled();
      expect(prisma.group.findMany).toHaveBeenCalled();
    });

    it('never writes a null recurrence rule, even bypassing the DTO', async () => {
      const { service, prisma } = setup();

      // The service is also reachable from places that don't run the HTTP
      // validation — the MAX bot dialog on step 10. A null here un-templated
      // the post: it stopped firing, vanished from the templates API, and
      // reappeared on the campaign endpoints as a schedulable draft.
      await service.updateTemplate('tpl-1', {
        recurrenceRule: null as unknown as string,
      });

      const data = callArg<{ data: { recurrenceRule: string } }>(
        prisma.post.update,
        0,
        0,
      ).data;
      expect(data.recurrenceRule).toBe('0 10 * * *');
    });

    it('refuses a group that has never been confirmed', async () => {
      const { service, prisma } = setup();
      prisma.group.findMany.mockResolvedValue([
        { id: 'g1', status: 'pending_confirmation', title: 'черновик MAX' },
      ]);

      // It could never fire (the firing path needs `active`), and
      // GroupsService.rejectMaxGroup hard-deletes such a group — a target row
      // would block that with a raw FK error the admin sees as a 500.
      await expect(
        service.updateTemplate('tpl-1', { groupIds: ['g1'] }),
      ).rejects.toBeInstanceOf(AppException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('touches no targets when the edit does not mention them', async () => {
      const { service, prisma } = setup();

      await service.updateTemplate('tpl-1', { text: 'только текст' });

      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma.postTemplateTarget.deleteMany).not.toHaveBeenCalled();
    });
  });

  describe('getTemplate', () => {
    it('reports no_targets when every group went inactive', async () => {
      const { service, prisma } = setup();
      prisma.postTemplateTarget.findMany.mockResolvedValue([
        target('g1', 'bot_removed'),
        target('g2', 'token_invalid'),
      ]);

      const result = (await service.getTemplate('tpl-1')) as {
        state: string;
      };

      // The firing path drops inactive targets and an edit may keep them, so a
      // template whose last active group died publishes nothing while every
      // other signal still says "running".
      expect(result.state).toBe('no_targets');
    });

    it('reports running while at least one group is active', async () => {
      const { service, prisma } = setup();
      prisma.postTemplateTarget.findMany.mockResolvedValue([
        target('g1', 'active'),
        target('g2', 'bot_removed'),
      ]);

      const result = (await service.getTemplate('tpl-1')) as { state: string };

      expect(result.state).toBe('running');
    });

    it('keeps reporting disarmed when the admin also pauses it', async () => {
      const { service, prisma } = setup();
      prisma.post.findUnique.mockResolvedValue(
        template({ nextRunAt: null, templatePaused: true }),
      );
      prisma.postTemplateTarget.findMany.mockResolvedValue([target('g1')]);

      const result = (await service.getTemplate('tpl-1')) as { state: string };

      // Both hold at once when the firing path disarms a broken rule and the
      // admin then pauses it to investigate. Reporting `paused` buries the
      // broken rule behind a state the admin chose, and the resume button then
      // answers with a raw cron error and no explanation.
      expect(result.state).toBe('disarmed');
    });

    it('reports paused for an ordinary pause, which keeps its schedule', async () => {
      const { service, prisma } = setup();
      prisma.post.findUnique.mockResolvedValue(
        template({ templatePaused: true }),
      );
      prisma.postTemplateTarget.findMany.mockResolvedValue([target('g1')]);

      const result = (await service.getTemplate('tpl-1')) as { state: string };

      expect(result.state).toBe('paused');
    });

    it('reports disarmed when the schedule was cleared', async () => {
      const { service, prisma } = setup();
      prisma.post.findUnique.mockResolvedValue(template({ nextRunAt: null }));
      prisma.postTemplateTarget.findMany.mockResolvedValue([target('g1')]);

      const result = (await service.getTemplate('tpl-1')) as { state: string };

      expect(result.state).toBe('disarmed');
    });
  });

  describe('setPaused', () => {
    it('recomputes the next run when resuming', async () => {
      const { service, prisma } = setup();
      // The fixture must be *paused*, or `resuming` is false and this test
      // passes against the no-op path it is meant to guard.
      prisma.post.findUnique.mockResolvedValue(
        template({ templatePaused: true }),
      );

      await service.setPaused('tpl-1', false);

      // Without this, a template resumed after a long pause would fire at once
      // on a window that passed while it was deliberately off.
      const data = callArg<{ data: { nextRunAt?: Date } }>(
        prisma.post.update,
        0,
        0,
      ).data;
      expect(data.nextRunAt).toBeInstanceOf(Date);
      expect(data.nextRunAt!.getTime()).toBeGreaterThan(Date.now());
    });

    it('arms a disarmed template that was never paused', async () => {
      const { service, prisma } = setup();
      // A row predating the migration that added nextRunAt, or one stopped by
      // an unparseable rule. `templatePaused` is false, so the old `resuming`
      // check made this button do nothing at all, forever.
      prisma.post.findUnique.mockResolvedValue(
        template({ templatePaused: false, nextRunAt: null }),
      );

      await service.setPaused('tpl-1', false);

      const data = callArg<{ data: { nextRunAt?: Date } }>(
        prisma.post.update,
        0,
        0,
      ).data;
      expect(data.nextRunAt).toBeInstanceOf(Date);
    });

    it('writes the resolved timezone back when arming', async () => {
      const { service, prisma } = setup();
      prisma.post.findUnique.mockResolvedValue(
        template({ templatePaused: true, timezone: null }),
      );

      await service.setPaused('tpl-1', false);

      // Left NULL, the zone would be re-resolved from DEFAULT_TIMEZONE at every
      // firing — so moving the server and changing that env var would shift a
      // schedule that was armed under the old one.
      const data = callArg<{ data: { timezone?: string } }>(
        prisma.post.update,
        0,
        0,
      ).data;
      expect(data.timezone).toBe('Europe/Moscow');
    });

    it('leaves the schedule alone when pausing', async () => {
      const { service, prisma } = setup();

      await service.setPaused('tpl-1', true);

      const data = callArg<{ data: { nextRunAt?: Date } }>(
        prisma.post.update,
        0,
        0,
      ).data;
      expect(data.nextRunAt).toBeUndefined();
    });
  });

  describe('updateTemplate', () => {
    it('recomputes the next run when the schedule changes', async () => {
      const { service, prisma } = setup();

      await service.updateTemplate('tpl-1', { recurrenceRule: '0 12 * * *' });

      const data = callArg<{ data: { nextRunAt?: Date } }>(
        prisma.post.update,
        0,
        0,
      ).data;
      // A schedule change should take effect now, not after the old interval.
      expect(data.nextRunAt).toBeInstanceOf(Date);
    });

    it('leaves the next run alone when only the text changes', async () => {
      const { service, prisma } = setup();

      await service.updateTemplate('tpl-1', { text: 'новый текст' });

      const data = callArg<{ data: { nextRunAt?: Date } }>(
        prisma.post.update,
        0,
        0,
      ).data;
      expect(data.nextRunAt).toBeUndefined();
    });

    it('rejects an invalid new schedule without touching the template', async () => {
      const { service, prisma } = setup();

      await expect(
        service.updateTemplate('tpl-1', { recurrenceRule: 'ерунда' }),
      ).rejects.toBeInstanceOf(AppException);
      expect(prisma.post.update).not.toHaveBeenCalled();
    });

    it('refuses to treat an ordinary post as a template', async () => {
      const { service, prisma } = setup();
      prisma.post.findUnique.mockResolvedValue(
        template({ recurrenceRule: null }),
      );

      await expect(
        service.updateTemplate('tpl-1', { text: 'x' }),
      ).rejects.toBeInstanceOf(AppException);
    });
  });
});
