import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PinoLogger } from 'nestjs-pino';
import { AppException } from '../common/app-exception';
import { ErrorCode } from '../common/error-code.enum';
import { PrismaService } from '../prisma/prisma.service';
import { GroupStatus, Post } from '../generated/prisma/client';
import { PostsService } from './posts.service';
import { assertValidRecurrence, nextRunAfter } from './recurrence';

/** Occurrences returned by one `listOccurrences` call. */
export const OCCURRENCE_PAGE_SIZE = 100;

/**
 * How late a window may still be published.
 *
 * The sweep runs once a minute, so a healthy firing is seconds late and a
 * restart costs a minute or two. Ten minutes covers both with room to spare,
 * and anything beyond it is a window the app slept through — which this
 * feature must not resurrect, because the genuine window is usually close
 * behind and VK's wall.delete cannot undo the extra post.
 */
const LATE_WINDOW_GRACE_MS = 10 * 60 * 1000;

/**
 * Templates one sweep will fire, at most.
 *
 * Chosen against the sweep's own 30-second lock rather than as a throughput
 * figure: the work per template is a handful of round-trips, so fifty fits
 * comfortably inside the TTL even on a slow database, and what does not fit
 * waits a minute for the next sweep.
 */
const MAX_TEMPLATES_PER_SWEEP = 50;

export interface CreateTemplateInput {
  text: string;
  vkTextOverride?: string;
  maxTextOverride?: string;
  recurrenceRule: string;
  timezone?: string;
  groupIds: string[];
  attachmentIds?: string[];
}

export interface UpdateTemplateInput {
  /** Omitted means "leave as is". `null` is not a value any of these accept. */
  text?: string;
  vkTextOverride?: string | null;
  maxTextOverride?: string | null;
  recurrenceRule?: string;
  timezone?: string;
  groupIds?: string[];
  attachmentIds?: string[];
}

/**
 * Пустой текст шаблона — отказ на входе, а не тихая порча: каждое срабатывание
 * рождало бы пост, который VK и MAX отвергают. Проверка стоит в сервисе, а не
 * только в DTO, потому что сюда ходит и панель, и она DTO не проходит.
 */
function assertTemplateText(text: string): void {
  if (text.trim().length === 0) {
    throw new AppException(
      ErrorCode.VALIDATION_ERROR,
      'Текст повторяющегося поста не может быть пустым',
    );
  }
}

export type TemplateState = 'running' | 'paused' | 'disarmed' | 'no_targets';

export interface TemplateSummary {
  id: string;
  text: string;
  recurrenceRule: string;
  timezone: string | null;
  nextRunAt: Date | null;
  createdAt: Date;
  targetsCount: number;
  occurrencesCount: number;
  state: TemplateState;
}

/**
 * Состояние шаблона одним значением — см. `getTemplate` о том, почему каждая
 * из трёх «тихих остановок» названа отдельно.
 *
 * `disarmed` проверяется **раньше** `paused`: одновременно верны обе, когда
 * путь срабатывания разоружил шаблон со сломавшимся правилом, а админ потом
 * поставил его на паузу — и сообщить о паузе значило бы спрятать сломанное
 * правило за состоянием, которое человек выбрал сам.
 */
export function templateState(input: {
  nextRunAt: Date | null;
  templatePaused: boolean;
  targetStatuses: GroupStatus[];
}): TemplateState {
  if (!input.nextRunAt) {
    return 'disarmed';
  }
  if (input.templatePaused) {
    return 'paused';
  }
  return input.targetStatuses.some((status) => status === 'active')
    ? 'running'
    : 'no_targets';
}

/**
 * Recurring posts.
 *
 * A template is a `Post` carrying a `recurrenceRule`; it never goes through
 * delivery itself. Its targets live in `PostTemplateTarget` — an editable
 * list — rather than in `PostDelivery`, precisely because a template has no
 * deliveries of its own. Each firing creates a *child* post: a snapshot of the
 * text, attachments and targets as they are at that moment, which then lives
 * the ordinary campaign life. Editing the template therefore changes future
 * firings only, exactly as PLAN.md requires.
 */
@Injectable()
export class PostTemplatesService {
  private readonly defaultTimezone: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly posts: PostsService,
    config: ConfigService,
    private readonly logger: PinoLogger,
  ) {
    this.defaultTimezone = config.getOrThrow<string>('DEFAULT_TIMEZONE');
    this.logger.setContext(PostTemplatesService.name);
  }

  async createTemplate(input: CreateTemplateInput): Promise<Post> {
    assertTemplateText(input.text);
    const timezone = input.timezone ?? this.defaultTimezone;
    assertValidRecurrence(input.recurrenceRule, timezone);

    const groupIds = [...new Set(input.groupIds)];
    await this.posts.assertGroupsUsable(groupIds);
    const attachmentIds = input.attachmentIds ?? [];
    // Same checks a one-off post gets — the VK limit of 10 and the duplicate
    // guard. Skipping them here would be worse than for a single post: a
    // template that breaks the limit breaks every future occurrence.
    await this.posts.assertAttachmentsUsable(attachmentIds);

    return this.prisma.post.create({
      data: {
        text: input.text,
        vkTextOverride: input.vkTextOverride,
        maxTextOverride: input.maxTextOverride,
        recurrenceRule: input.recurrenceRule,
        timezone,
        nextRunAt: nextRunAfter(input.recurrenceRule, timezone),
        // The template's own `status` is meaningless — PLAN.md scopes status to
        // an occurrence, not to the template. It stays `draft` so that nothing
        // which looks for schedulable posts can mistake it for one.
        status: 'draft',
        templateTargets: {
          create: groupIds.map((groupId) => ({ groupId })),
        },
        attachments: {
          create: attachmentIds.map((mediaAssetId, position) => ({
            mediaAssetId,
            position,
          })),
        },
      },
    });
  }

  /** Edits affect future firings only; already published occurrences are untouched. */
  async updateTemplate(id: string, input: UpdateTemplateInput): Promise<Post> {
    if (input.text !== undefined) {
      assertTemplateText(input.text);
    }
    const template = await this.findTemplateOrThrow(id);

    const recurrenceRule = input.recurrenceRule ?? template.recurrenceRule!;
    const timezone =
      input.timezone ?? template.timezone ?? this.defaultTimezone;
    // Compared by value, not by field presence: a panel edit form PATCHes the
    // whole template, so an unrelated change (fixing a typo in the text) would
    // otherwise recompute nextRunAt from now and silently skip the window that
    // was minutes away.
    const scheduleChanged =
      recurrenceRule !== template.recurrenceRule ||
      timezone !== (template.timezone ?? this.defaultTimezone);
    // A template with no nextRunAt is disarmed: it never fires and never logs.
    // Rows predating the migration that added the column are in that state, and
    // so is a template stopped by an unparseable rule. Any edit arms it — which
    // is what makes "fix the broken rule" a one-step recovery, and what the
    // migration's comment promises.
    const rearm = template.nextRunAt === null;
    if (scheduleChanged || rearm) {
      assertValidRecurrence(recurrenceRule, timezone);
    }

    const groupIds = input.groupIds ? [...new Set(input.groupIds)] : undefined;
    if (groupIds) {
      // Existence only — *not* `assertGroupsUsable`. That check rejects the
      // whole edit if any group is inactive, which contradicts the firing path:
      // it deliberately skips an inactive target and keeps it in the list in
      // case the group recovers. With the stricter check a panel doing
      // read-modify-write on the list could not add a group without first
      // dropping the one that went `token_invalid` — exactly what firing
      // promises not to require.
      await this.assertGroupsExist(groupIds);
    }
    const attachmentIds = input.attachmentIds;
    if (attachmentIds) {
      await this.posts.assertAttachmentsUsable(attachmentIds);
    }

    const updateTemplateRow = this.prisma.post.update({
      where: { id },
      data: {
        text: input.text,
        vkTextOverride: input.vkTextOverride,
        maxTextOverride: input.maxTextOverride,
        // Both resolved locals, never `input.*`. For the zone: a row whose
        // timezone is still NULL would otherwise keep resolving it from
        // DEFAULT_TIMEZONE at every firing, while nextRunAt was already
        // computed from that env var here — so changing the env var later would
        // move "every day at 10:00", which is the one thing storing the zone is
        // meant to prevent. For the rule: writing `input.recurrenceRule`
        // straight through let a `null` erase it, which quietly un-templated
        // the post — it stopped firing, disappeared from the templates API, and
        // reappeared on the campaign endpoints as a draft that could be
        // "scheduled" into a post with no deliveries. The resolved local is
        // never null: it falls back to the stored rule, which
        // `findTemplateOrThrow` has already proven non-null.
        recurrenceRule,
        timezone,
        // Recomputed from now, so a schedule change takes effect immediately
        // instead of waiting out the old interval.
        ...(scheduleChanged || rearm
          ? { nextRunAt: nextRunAfter(recurrenceRule, timezone) }
          : {}),
      },
    });

    if (!groupIds && !attachmentIds) {
      return updateTemplateRow;
    }

    // Targets and attachments are replaced wholesale (they are what the admin
    // sees and edits, and the rows carry no state worth diffing) — but in the
    // *same* transaction as the template row. Committed separately, a failing
    // update returned an error implying nothing had changed while the new list
    // was already live: the next firing would go to the new groups with the old
    // text and schedule.
    const ops = [
      ...(groupIds
        ? [
            this.prisma.postTemplateTarget.deleteMany({
              where: { postId: id },
            }),
            this.prisma.postTemplateTarget.createMany({
              data: groupIds.map((groupId) => ({ postId: id, groupId })),
            }),
          ]
        : []),
      // Attachments are replaced wholesale too, and `position` is reassigned
      // from the new order — it is what decides the order VK shows them in.
      ...(attachmentIds
        ? [
            this.prisma.postAttachment.deleteMany({ where: { postId: id } }),
            this.prisma.postAttachment.createMany({
              data: attachmentIds.map((mediaAssetId, position) => ({
                postId: id,
                mediaAssetId,
                position,
              })),
            }),
          ]
        : []),
      updateTemplateRow,
    ];
    const results = await this.prisma.$transaction(ops);
    return results[results.length - 1] as Post;
  }

  /**
   * Pausing leaves `nextRunAt` alone; resuming recomputes it from now, so a
   * template switched back on after a long pause doesn't fire immediately on a
   * window that passed while it was deliberately off.
   *
   * The recompute happens only on a real pause→run transition. Without that
   * check, "resuming" an already-running template — a double-clicked button, a
   * retried request, a panel that PATCHes current state — would push the next
   * firing past a window that was minutes away and drop that post silently.
   */
  async setPaused(id: string, paused: boolean): Promise<Post> {
    const template = await this.findTemplateOrThrow(id);
    // Also arms a template that is disarmed without being paused — a
    // pre-migration row, or one stopped by an unparseable rule. Without this,
    // `resuming` was false for a template that had never been paused and the
    // button did nothing at all, forever.
    const resuming =
      !paused && (template.templatePaused || !template.nextRunAt);
    const timezone = template.timezone ?? this.defaultTimezone;
    return this.prisma.post.update({
      where: { id },
      data: {
        templatePaused: paused,
        ...(resuming
          ? {
              nextRunAt: nextRunAfter(template.recurrenceRule!, timezone),
              // Written back, not just used: a row whose timezone is still NULL
              // would keep resolving it from DEFAULT_TIMEZONE at every firing,
              // so moving the server and changing that env var would shift a
              // schedule that was armed under the old one.
              timezone,
            }
          : {}),
      },
    });
  }

  /** Fires every template whose time has come. Called by the reconciler. */
  async fireDueTemplates(now: Date = new Date()): Promise<number> {
    const due = await this.prisma.post.findMany({
      where: {
        recurrenceRule: { not: null },
        templatePaused: false,
        nextRunAt: { lte: now },
      },
      // Oldest window first, and bounded. Each template costs a claim, a
      // RepeatableRead read, a create and a queue.add; unbounded, the first
      // sweep after an outage — when every template is due — could run past the
      // reconciler's 30s Redis lock, which is never refreshed. The lock would
      // then expire mid-sweep and a second instance would start sweeping
      // alongside, which is exactly what it exists to prevent. The remainder is
      // picked up by the next sweep a minute later; ordering by `nextRunAt`
      // keeps that fair, so nothing is starved behind a large backlog.
      orderBy: { nextRunAt: 'asc' },
      take: MAX_TEMPLATES_PER_SWEEP,
    });

    let fired = 0;
    for (const template of due) {
      try {
        // A per-template clock, not the one the `findMany` filtered on. Each
        // iteration does a claim, a RepeatableRead read, a token check, a
        // create and a queue.add; on a backlog after an outage the loop can
        // outrun the schedule interval, and a `next` computed from the loop's
        // start is then already behind the wall clock — so the next sweep sees
        // the template due again and publishes a second occurrence inside the
        // same window. Same staleness the reconciler was fixed for, one level
        // down. The `findMany` filter deliberately keeps the original `now`, so
        // the due set stays the one that was read.
        const at = new Date();
        // Shared by both paths below: whichever way this window goes, the next
        // one has to be computed, and an unparseable stored rule has to disarm
        // the template rather than throw. Leaving that only in `fireTemplate`
        // made it unreachable for a stale template — the stale path threw
        // instead, `nextRunAt` never moved, and the sweep repeated it once a
        // minute forever while `getTemplate` still said `running`.
        const next = await this.nextWindowOrDisarm(template, at);
        if (!next) {
          continue;
        }
        // A window more than `LATE_WINDOW_GRACE_MS` old is abandoned, not
        // published late. Without the bound, a daily 10:00 template with the
        // app down from Monday to Wednesday 09:00 fired *immediately* on
        // recovery — an occurrence an hour off schedule — and then again at
        // 10:00 for the genuine window: two posts an hour apart, on walls
        // wall.delete cannot clean up. "Fires once on start" was only ever
        // meant to cover a restart, not to resurrect yesterday's window.
        // Measured from the sweep's own start, not from `at`. `at` is read per
        // template so the *next* window lands in the future; using it here
        // instead would charge each template for how long the recovery passes
        // ahead of it took, and a backlog longer than the grace bound would
        // silently drop every template's post — a warn, and `getTemplate` still
        // saying `running`. Lateness is a property of the window, not of our
        // queueing.
        const lateBy = now.getTime() - (template.nextRunAt?.getTime() ?? 0);
        if (lateBy > LATE_WINDOW_GRACE_MS) {
          await this.skipStaleWindow(template, next, lateBy);
          continue;
        }
        if (await this.fireTemplate(template, next)) {
          fired += 1;
        }
      } catch (err: unknown) {
        this.logger.error(
          { err, templateId: template.id },
          'Не удалось создать вхождение повторяющегося поста',
        );
      }
    }
    return fired;
  }

  /**
   * Moves a stale window on without publishing, under the same conditional
   * claim a real firing uses — so a concurrent sweep cannot publish the window
   * this one just abandoned.
   */
  private async skipStaleWindow(
    template: Post,
    next: Date,
    lateBy: number,
  ): Promise<void> {
    const moved = await this.prisma.post.updateMany({
      // The same conditional claim a real firing uses, `templatePaused` and
      // all — the doc comment above says so, and it was not true: a pause
      // landing mid-sweep left this path still moving the window on.
      where: {
        id: template.id,
        nextRunAt: template.nextRunAt,
        templatePaused: false,
      },
      data: { nextRunAt: next },
    });
    if (moved.count > 0) {
      this.logger.warn(
        {
          templateId: template.id,
          lateByMinutes: Math.round(lateBy / 60_000),
          nextRunAt: next,
        },
        'Окно шаблона просрочено — срабатывание пропущено, ждём следующего',
      );
    }
  }

  /**
   * One firing: claim the window, then snapshot the template into a child post.
   *
   * The claim comes first and is conditional on `nextRunAt` still holding the
   * value we read. If the child then fails to be created, the window is
   * *skipped* rather than retried — the same trade this project makes
   * everywhere, because a missed post is recoverable by hand and a duplicate
   * one, on a wall we cannot delete from, is not.
   */
  /**
   * The next window for this template, or `null` if its stored rule no longer
   * parses — in which case the template is disarmed rather than retried.
   *
   * A rule can stop parsing without anyone touching it (a hand-edited row, a
   * cron-parser upgrade tightening the grammar). Left to throw, `nextRunAt`
   * never moves and every sweep re-tries and re-logs the same template once a
   * minute, forever, while `getTemplate` still reports it as running.
   */
  private async nextWindowOrDisarm(
    template: Post,
    at: Date,
  ): Promise<Date | null> {
    const timezone = template.timezone ?? this.defaultTimezone;
    try {
      return nextRunAfter(template.recurrenceRule!, timezone, at);
    } catch (err: unknown) {
      this.logger.error(
        {
          err,
          templateId: template.id,
          recurrenceRule: template.recurrenceRule,
        },
        'Расписание шаблона нечитаемо — шаблон остановлен до правки',
      );
      await this.prisma.post.updateMany({
        // `templatePaused: false` like both sibling claims: a pause landing
        // between the sweep's findMany and this write would otherwise leave the
        // row paused *and* disarmed, and `getTemplate` checks `paused` first —
        // hiding the unreadable rule behind a state the admin chose, so the
        // resume button would 400 with no explanation.
        where: {
          id: template.id,
          nextRunAt: template.nextRunAt,
          templatePaused: false,
        },
        // `nextRunAt: null` is the one signal for "disarmed", and it is not
        // accompanied by `templatePaused: true`: pausing is the admin's switch,
        // and setting it here would misreport who stopped the template.
        //
        // Recovery is a PATCH carrying a rule that parses — nothing else. A
        // plain text edit and the resume button both re-parse the stored rule
        // and fail with the 400 that names it, which is the honest answer, not
        // a rescue. `getTemplate` reports `state: 'disarmed'` meanwhile.
        data: { nextRunAt: null },
      });
      return null;
    }
  }

  private async fireTemplate(template: Post, next: Date): Promise<boolean> {
    const claimed = await this.prisma.post.updateMany({
      // `templatePaused` is re-checked here, not just in the query that
      // selected this template: the due set is read up front and fired one by
      // one, so a pause landing in between would otherwise still publish one
      // more post — onto a wall VK won't let us delete from.
      where: {
        id: template.id,
        nextRunAt: template.nextRunAt,
        templatePaused: false,
      },
      data: { nextRunAt: next },
    });
    if (claimed.count === 0) {
      // Another sweep took this window first.
      return false;
    }

    // Re-read rather than taken from the sweep's snapshot, and read at
    // REPEATABLE READ. `include` is *not* one statement — verified against this
    // schema, a findUnique with these relations issues four separate SELECTs —
    // so under the default READ COMMITTED each gets its own snapshot, and an
    // `updateTemplate` committing in between would hand this firing the old
    // text with the new targets and attachments: precisely the torn state that
    // transaction was introduced to prevent, moved to the read side. The
    // transaction is read-only, so it cannot hit a serialization failure.
    const fresh = await this.prisma.$transaction(
      (tx) =>
        tx.post.findUnique({
          where: { id: template.id },
          include: {
            templateTargets: {
              include: {
                group: {
                  select: {
                    id: true,
                    status: true,
                    title: true,
                    platform: true,
                  },
                },
              },
            },
            attachments: {
              orderBy: { position: 'asc' },
              select: { mediaAssetId: true },
            },
          },
        }),
      { isolationLevel: 'RepeatableRead' },
    );
    if (!fresh) {
      // Deleted between the claim and now.
      return false;
    }
    const targets = fresh.templateTargets;
    // A group that went `bot_removed` or had its token invalidated since the
    // template was written is simply left out of this run: dropping one target
    // is better than cancelling the whole firing, and the template keeps it for
    // later in case the group recovers.
    const deliverable = targets.filter((t) => t.group.status === 'active');
    const skipped = targets.length - deliverable.length;
    if (deliverable.length === 0) {
      this.logger.warn(
        { templateId: template.id, targets: targets.length },
        'У шаблона нет доступных групп — срабатывание пропущено',
      );
      return false;
    }
    if (skipped > 0) {
      this.logger.warn(
        { templateId: template.id, skipped },
        'Часть групп шаблона недоступна и в это срабатывание не войдёт',
      );
    }

    const attachments = fresh.attachments;

    // Asked before the occurrence exists, not after: an occurrence created
    // while the personal VK token is dead sits in `scheduled` forever, and the
    // next firing adds another. See PostsService.publishableVkGroups.
    //
    // Nothing is dropped wholesale. MAX uploads use the bot token, and a VK
    // group whose files are already cached on VK's side needs no token either
    // — so only the VK groups that genuinely cannot be reached fall out of this
    // run. The alternative silently lost posts that would have worked, and
    // unlike a one-off campaign (which the processor leaves in `scheduled` for
    // the reconciler to re-offer) this window is already claimed, so they were
    // gone for good.
    const vkTargets = deliverable.filter((t) => t.group.platform === 'vk');
    const publishableVk = new Set(
      await this.posts.publishableVkGroups(
        attachments.map((a) => a.mediaAssetId),
        vkTargets.map((t) => t.groupId),
      ),
    );
    const recipients = deliverable.filter(
      (t) => t.group.platform !== 'vk' || publishableVk.has(t.groupId),
    );
    const droppedVkTargets = deliverable.length - recipients.length;
    if (droppedVkTargets > 0) {
      this.logger.error(
        { templateId: template.id, nextRunAt: next, droppedVkTargets },
        'Личный VK-токен истёк — часть VK-целей шаблона в это срабатывание не войдёт',
      );
    }
    if (recipients.length === 0) {
      // Everything this firing could have reached needed the dead token.
      return false;
    }

    const occurrence = await this.prisma.post.create({
      data: {
        text: fresh.text,
        vkTextOverride: fresh.vkTextOverride,
        maxTextOverride: fresh.maxTextOverride,
        recurringTemplateId: template.id,
        status: 'scheduled',
        deliveries: {
          create: recipients.map((t) => ({ groupId: t.groupId })),
        },
        attachments: {
          create: attachments.map((a, position) => ({
            mediaAssetId: a.mediaAssetId,
            position,
          })),
        },
      },
    });

    await this.posts.enqueueDispatch(occurrence);
    this.logger.info(
      { templateId: template.id, occurrenceId: occurrence.id, nextRunAt: next },
      'Создано вхождение повторяющегося поста',
    );
    return true;
  }

  /**
   * Сводка для списка шаблонов в панели.
   *
   * Состояние считается тем же правилом, что и в `getTemplate`, и по той же
   * причине: шаблон, который перестал публиковать, но выглядит «работает», —
   * это отказ, который замечают через неделю пропавших постов. Считать его
   * в шаблоне списка было бы тем же правилом во втором экземпляре, а такие
   * расходятся молча.
   */
  async listTemplates(limit = 50): Promise<TemplateSummary[]> {
    const templates = await this.prisma.post.findMany({
      where: { recurrenceRule: { not: null } },
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: {
        templateTargets: { select: { group: { select: { status: true } } } },
        _count: { select: { occurrences: true } },
      },
    });

    return templates.map((template) => ({
      id: template.id,
      text: template.text,
      recurrenceRule: template.recurrenceRule!,
      timezone: template.timezone,
      nextRunAt: template.nextRunAt,
      createdAt: template.createdAt,
      targetsCount: template.templateTargets.length,
      occurrencesCount: template._count.occurrences,
      state: templateState({
        nextRunAt: template.nextRunAt,
        templatePaused: template.templatePaused,
        targetStatuses: template.templateTargets.map((t) => t.group.status),
      }),
    }));
  }

  /**
   * Most recent occurrences first, capped: an hourly template running for a
   * year has ~8760 of them, and the panel shows the latest ones.
   */
  async listOccurrences(id: string, limit = OCCURRENCE_PAGE_SIZE) {
    await this.findTemplateOrThrow(id);
    return this.prisma.post.findMany({
      where: { recurringTemplateId: id },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(limit, 1), OCCURRENCE_PAGE_SIZE),
      select: { id: true, status: true, createdAt: true, updatedAt: true },
    });
  }

  async getTemplate(id: string) {
    const template = await this.findTemplateOrThrow(id);
    const targets = await this.prisma.postTemplateTarget.findMany({
      where: { postId: id },
      include: {
        group: {
          select: { id: true, title: true, platform: true, status: true },
        },
      },
    });
    // Stated outright rather than left for the panel to infer from a null:
    // a template that silently stopped firing while still looking "running"
    // is the failure nobody notices until a week of posts is missing.
    //
    // `no_targets` is the third way to stop silently, and the one the firing
    // path creates on its own: an edit may keep an inactive group in the list
    // (it is allowed to, in case the group recovers), so a template whose last
    // active group flips to `token_invalid` publishes nothing while every other
    // signal still says "running".
    // `disarmed` is checked *before* `paused`: the two can hold at once — the
    // firing path disarms a template whose rule stopped parsing, and the admin
    // then pauses it while investigating. Reporting `paused` there would bury
    // the broken rule behind a state the admin chose, and the resume button
    // would answer with a raw cron error and no explanation. A template paused
    // the ordinary way keeps its `nextRunAt`, so it still reads as `paused`.
    const state = templateState({
      nextRunAt: template.nextRunAt,
      templatePaused: template.templatePaused,
      targetStatuses: targets.map((t) => t.group.status),
    });
    return { ...template, state, targets: targets.map((t) => t.group) };
  }

  /**
   * Looser than `assertGroupsUsable`: an inactive group may stay in a
   * template's target list, because the firing path skips it and it may
   * recover. A group awaiting confirmation is not that case — it has never
   * been active, so it could never fire, and `GroupsService.rejectMaxGroup`
   * hard-deletes it, which a `PostTemplateTarget` row would block with a raw
   * FK error (nothing maps P2003, so the admin would get a 500 for rejecting
   * their own draft).
   */
  private async assertGroupsExist(groupIds: string[]): Promise<void> {
    if (groupIds.length === 0) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'Нужно выбрать хотя бы одну группу',
      );
    }
    const groups = await this.prisma.group.findMany({
      where: { id: { in: groupIds } },
      select: { id: true, status: true, title: true },
    });
    if (groups.length !== groupIds.length) {
      throw new AppException(ErrorCode.NOT_FOUND, 'Часть групп не найдена');
    }
    const unconfirmed = groups.filter(
      (group) => group.status === 'pending_confirmation',
    );
    if (unconfirmed.length > 0) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        `Группы ещё не подтверждены: ${unconfirmed.map((g) => g.title).join(', ')}`,
      );
    }
  }

  private async findTemplateOrThrow(id: string): Promise<Post> {
    const template = await this.prisma.post.findUnique({ where: { id } });
    if (!template) {
      throw new AppException(ErrorCode.NOT_FOUND, 'Шаблон не найден');
    }
    if (!template.recurrenceRule) {
      throw new AppException(
        ErrorCode.REQUEST_ERROR,
        'Этот пост не является повторяющимся шаблоном',
      );
    }
    return template;
  }
}
