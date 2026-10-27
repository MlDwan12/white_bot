import { Injectable } from '@nestjs/common';
import { isUniqueViolation } from '../common/prisma-errors';
import type { AttachmentRequest } from '@maxhub/max-bot-api/types';
import { PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../prisma/prisma.service';
import {
  Group,
  MediaAsset,
  MediaKind,
  Platform,
} from '../generated/prisma/client';
import { MediaService } from '../media/media.service';
import { VkApiClient, type VkAttachmentInput } from '../vk/vk-api.client';
import { MaxApiClient, MaxAttachmentInput } from '../max/max-api.client';
import { VkUploaderTokenService } from '../vk/vk-uploader-token.service';

/**
 * Cache scope for MAX. Its attachment tokens are issued to the bot and work in
 * every chat it belongs to, so one upload serves all of them — unlike VK,
 * where a file must be uploaded into each community separately.
 */
export const MAX_SCOPE = 'bot';

/**
 * Cached MAX references are ignored past this age.
 *
 * MAX documents no lifetime for an attachment token, and the scope above is
 * tied to "the bot" rather than to a specific bot identity — so a rotated
 * MAX_BOT_TOKEN, or a token MAX expires on its own, would otherwise leave us
 * replaying a dead reference forever with no way out but deleting rows by
 * hand. This is a bound on that blast radius, not a documented lifetime.
 * VK references don't expire and aren't aged.
 */
const MAX_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Видео в кэше старше этого MAX уже обработал — готовность не опрашиваем. */
const VIDEO_SETTLED_MS = 10 * 60 * 1000;

/**
 * Turns stored files into platform attachment references, reusing previous
 * uploads.
 *
 * The cache is not an optimisation detail: without it a retry after a rate
 * limit, or "отправить оставшимся", would re-upload the same file to the same
 * community every time — wasting the very rate-limit budget that caused the
 * retry.
 */
@Injectable()
export class AttachmentUploader {
  constructor(
    private readonly prisma: PrismaService,
    private readonly media: MediaService,
    private readonly vk: VkApiClient,
    private readonly max: MaxApiClient,
    private readonly vkUploaderToken: VkUploaderTokenService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(AttachmentUploader.name);
  }

  /** VK wall attachment strings, in the post's own attachment order. */
  async vkRefs(assets: MediaAsset[], group: Group): Promise<string[]> {
    // Fetched lazily, on the first file that actually needs uploading. Asking
    // for it up front would break the case the cache exists for: every
    // attachment already uploaded into this community, nothing to send, yet
    // an expired token would refuse the delivery anyway.
    let token: string | undefined;
    const getToken = async (): Promise<string> =>
      (token ??= await this.vkUploaderToken.getValidAccessToken());

    const refs: string[] = [];
    for (const asset of assets) {
      refs.push(
        // Видео — со своим ключом кэша: до 23.09.2026 оно уходило в VK
        // документом, и под обычным ключом лежит `doc…`, который иначе
        // продолжал бы подставляться вместо видеозаписи.
        (
          await this.resolve(
            'vk',
            vkUploadScope(group.id, asset.kind),
            asset,
            async () => {
              const buffer = await this.media.readForUpload(asset);
              return this.vk.uploadAttachment(
                await getToken(),
                group.externalId,
                {
                  kind: AttachmentUploader.vkUploadKind(asset.kind),
                  filename: asset.filename,
                  mimeType: asset.mimeType,
                  buffer,
                },
              );
            },
          )
        ).externalRef,
      );
    }
    return refs;
  }

  /** MAX attachment objects, ready to hand to a send call. */
  async maxAttachments(assets: MediaAsset[]): Promise<AttachmentRequest[]> {
    const attachments: AttachmentRequest[] = [];
    for (const asset of assets) {
      // Видео — под своим ключом, как и у VK: файл, загруженный раньше
      // документом и потом распознанный как видео, иначе ещё неделю уходил бы
      // из кэша файлом на скачивание, а не проигрывателем.
      const scope = asset.kind === 'video' ? `${MAX_SCOPE}:video` : MAX_SCOPE;
      const { externalRef: ref, cachedAt } = await this.resolve(
        'max',
        scope,
        asset,
        async () =>
          // A path carrying the original file name, not the bytes: the SDK takes
          // the displayed name from its source, so a Buffer would show a random
          // uuid and the raw storage path would show our generated one. For a
          // document that name is what the recipient sees.
          this.media.withUploadPath(asset, async (source) => {
            const attachment = await this.max.uploadAttachment({
              kind: AttachmentUploader.maxUploadKind(asset.kind),
              source,
            });
            // Без токена ждать готовности нечем — а закэшировать такое видео
            // значило бы неделю отдавать ссылку, которую MAX отвергнет.
            if (attachment.type === 'video' && !attachment.payload.token) {
              throw new Error('MAX не вернул токен загруженного видео');
            }
            return JSON.stringify(attachment);
          }),
      );
      const attachment = JSON.parse(ref) as AttachmentRequest;
      // Видео MAX ещё перекодирует, и сообщение с ним до этого отвергается.
      // Ждём **после** записи в кэш: если обработка дольше срока ожидания,
      // повтор доставки найдёт в кэше то же видео (к тому времени
      // обработанное), а не зальёт его заново и снова упрётся в срок. Видео,
      // давно лежащее в кэше, не опрашиваем: лишний запрос на каждую
      // доставку тратил бы лимит MAX, а сбой опроса ронял бы готовое видео.
      // ponytail: «давно» — по возрасту записи, а не по факту готовности;
      // если MAX начнёт обрабатывать дольше 10 мин — хранить флаг готовности.
      if (
        attachment.type === 'video' &&
        attachment.payload.token &&
        (!cachedAt || Date.now() - cachedAt.getTime() < VIDEO_SETTLED_MS)
      ) {
        await this.max.waitForVideoReady(attachment.payload.token);
      }
      attachments.push(attachment);
    }
    return attachments;
  }

  /**
   * Returns a cached reference or produces one and stores it.
   *
   * The write races with a concurrent delivery of the same file into the same
   * scope; the unique constraint settles it, and the loser re-reads the
   * winner's row. Both then publish the identical reference, so the extra
   * upload costs a request but never a wrong result.
   */
  private async resolve(
    platform: Platform,
    scope: string,
    asset: MediaAsset,
    upload: () => Promise<string>,
  ): Promise<{ externalRef: string; cachedAt: Date | null }> {
    const where = {
      mediaAssetId_platform_scope: {
        mediaAssetId: asset.id,
        platform,
        scope,
      },
    };
    const cached = await this.prisma.mediaPlatformUpload.findUnique({ where });
    if (cached && this.isFresh(platform, cached.createdAt)) {
      // Когда ссылка легла в кэш: по возрасту видно, успел ли MAX
      // обработать видео (см. `maxAttachments`).
      return { externalRef: cached.externalRef, cachedAt: cached.createdAt };
    }

    const externalRef = await upload();
    // Свежая загрузка (или чужая, выигравшая гонку секунды назад) — для
    // проверки готовности видео она «только что легла в кэш».
    const fresh = { externalRef, cachedAt: null };

    if (cached) {
      // Stale MAX entry: replace it rather than leaving the dead reference to
      // be picked up again by the next delivery.
      await this.prisma.mediaPlatformUpload
        .update({ where, data: { externalRef, createdAt: new Date() } })
        .catch((err: unknown) =>
          this.logger.warn(
            { err, assetId: asset.id, platform },
            'Не удалось обновить устаревшую ссылку на вложение',
          ),
        );
      return fresh;
    }

    try {
      await this.prisma.mediaPlatformUpload.create({
        data: { mediaAssetId: asset.id, platform, scope, externalRef },
      });
      return fresh;
    } catch (err: unknown) {
      if (isUniqueViolation(err)) {
        const winner = await this.prisma.mediaPlatformUpload.findUnique({
          where,
        });
        return {
          externalRef: winner?.externalRef ?? externalRef,
          cachedAt: null,
        };
      }
      // Any other failure means the cache stays cold and the next retry will
      // upload this file again — wasteful, but not wrong, so the delivery
      // proceeds. Logged, because silently losing the cache is exactly the
      // rate-limit waste it was built to prevent.
      this.logger.warn(
        { err, assetId: asset.id, platform, scope },
        'Не удалось сохранить ссылку на загруженное вложение в кэш',
      );
      return fresh;
    }
  }

  /** VK references never expire; MAX ones are aged out — see MAX_CACHE_TTL_MS. */
  private isFresh(platform: Platform, createdAt: Date): boolean {
    return (
      platform === 'vk' || Date.now() - createdAt.getTime() < MAX_CACHE_TTL_MS
    );
  }

  /**
   * MAX-вид вложения для конкретного метода загрузки (`uploadImage` /
   * `uploadVideo` / `uploadFile`) — без него видео уходило бы файлом, не
   * проигрывателем. `audio` наш конвейер не производит ни при каком
   * `MediaKind`, поэтому недостижим и здесь.
   */
  private static maxUploadKind(kind: MediaKind): MaxAttachmentInput['kind'] {
    switch (kind) {
      case 'image':
        return 'image';
      case 'video':
        return 'video';
      case 'document':
        return 'file';
    }
  }

  /** `MediaKind` → вид вложения VK: видео — видеозаписью, а не документом. */
  private static vkUploadKind(kind: MediaKind): VkAttachmentInput['kind'] {
    switch (kind) {
      case 'image':
        return 'photo';
      case 'video':
        return 'video';
      case 'document':
        return 'doc';
    }
  }
}

/**
 * Ключ кэша загрузки в VK-сообщество. Видео — со своим ключом: до 23.09.2026
 * оно уходило в VK документом, и под обычным ключом лежит `doc…`. Экспортом,
 * а не приватным методом: проверка «нужен ли токен загрузчика»
 * (`PostsService`) обязана искать кэш по тому же ключу.
 */
export function vkUploadScope(groupId: string, kind: MediaKind): string {
  return kind === 'video' ? `${groupId}:video` : groupId;
}
