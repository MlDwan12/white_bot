import { Injectable } from '@nestjs/common';
import { VkApiError } from './vk-api.error';

// Fixed explicitly rather than left to VK's default so a platform-side
// default bump can't silently change response shapes under us.
const VK_API_VERSION = '5.199';
const VK_API_BASE = 'https://api.vk.com/method';
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Pushing file bytes is not one round trip: a 20 MB document on a modest
 * uplink needs far longer than an API call, and the 10s budget above would
 * abort it midway. An aborted upload surfaces as an ambiguous failure, which
 * sends the whole delivery to `unknown` for manual checking — an expensive
 * outcome for a slow connection. Mirrors the 60s the MAX client already uses.
 */
const UPLOAD_TIMEOUT_MS = 60_000;

export interface VkGroupInfo {
  externalId: string;
  title: string;
}

export interface VkAttachmentInput {
  kind: 'photo' | 'doc';
  filename: string;
  mimeType: string;
  buffer: Buffer;
}

async function parseVkResponse<T>(res: globalThis.Response): Promise<T> {
  if (!res.ok) {
    // VK's own API errors come back as HTTP 200 with an `error` field in the
    // body (handled below) — a non-2xx here means something in front of the
    // API (a proxy, an outage page) returned a body that likely isn't JSON.
    throw new VkApiError(0, `VK API вернул HTTP ${res.status}`);
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new VkApiError(0, 'VK API вернул нераспознаваемый ответ');
  }

  if (typeof body === 'object' && body !== null && 'error' in body) {
    const err = body.error;
    const code =
      typeof err === 'object' && err !== null && 'error_code' in err
        ? err.error_code
        : undefined;
    const msg =
      typeof err === 'object' && err !== null && 'error_msg' in err
        ? err.error_msg
        : undefined;
    throw new VkApiError(
      typeof code === 'number' ? code : 0,
      typeof msg === 'string' ? msg : 'Ошибка VK API',
    );
  }

  if (typeof body === 'object' && body !== null && 'response' in body) {
    return (body as { response: T }).response;
  }

  throw new Error('Неожиданный формат ответа VK API');
}

/**
 * Thin client around VK's HTTP API: resolving/validating a community token
 * (used by Groups), and the wall-post content methods (text, photo/document
 * attachments) used by the VK-integration step. No queueing/retry logic
 * here — that's the delivery pipeline's job, built on top of this.
 */
@Injectable()
export class VkApiClient {
  private async call<T>(
    method: string,
    token: string,
    params: Record<string, string>,
  ): Promise<T> {
    const body = new URLSearchParams({
      ...params,
      access_token: token,
      v: VK_API_VERSION,
    });
    // Never log `body`/`token` here — it carries the raw access token, and
    // this call sits outside pino's request/response logging entirely.
    const res = await fetch(`${VK_API_BASE}/${method}`, {
      method: 'POST',
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return parseVkResponse<T>(res);
  }

  /** Resolves a community token to its own group — no `group_id` needed. */
  async resolveGroupInfo(token: string): Promise<VkGroupInfo> {
    const response = await this.call<
      | { id: number; name: string }[]
      | { groups: { id: number; name: string }[] }
    >('groups.getById', token, {});

    const group = Array.isArray(response) ? response[0] : response.groups[0];
    if (!group) {
      throw new VkApiError(0, 'VK не вернул информацию о сообществе');
    }
    return { externalId: String(group.id), title: group.name };
  }

  /** Posts the connection-check message to the community's own wall. */
  async postTestMessage(token: string, externalId: string): Promise<void> {
    await this.wallPost(token, externalId, '✅ Бот подключён');
  }

  async wallPost(
    token: string,
    externalId: string,
    message: string,
    attachmentRefs: string[] = [],
  ): Promise<{ postId: number }> {
    const response = await this.call<{ post_id: number }>('wall.post', token, {
      owner_id: this.wallOwnerId(externalId),
      from_group: '1',
      message,
      ...(attachmentRefs.length > 0
        ? { attachments: attachmentRefs.join(',') }
        : {}),
    });
    return { postId: response.post_id };
  }

  /**
   * Confirmed empirically (2026-09-17) that VK currently rejects this for
   * *any* token/app type we could get: error 27 with a community token
   * ("unavailable with group auth"), error 15 with a personal token from a
   * self-service app ("denied for non-standalone applications"). VK's own
   * docs say wall.edit/wall.delete rights require a manual grant from
   * devsupport@corp.vk.com — not something a token/app-type change fixes.
   * Left implemented (request shape is correct, proven via curl) since it
   * should start working the moment that grant exists, with no code change.
   *
   * `attachments` — присылается всегда, даже пустой строкой, а не только
   * когда есть что прикрепить. Причина та же, что и у MAX (`buildEditExtra`
   * в `max-api.client.ts`, подтверждено там живьём): при правке уже
   * опубликованного отсутствие параметра, скорее всего, не то же самое, что
   * пустой список — иначе снять все вложения с поста через панель было бы
   * нечем. **Само предположение для VK живьём не проверено** — wall.edit
   * сейчас отклоняется для любого значения параметра (см. выше), поэтому
   * правка тут ничем не рискует: заменить нечего, пока не будут одобрены
   * права. Перепроверить, когда придёт одобрение.
   */
  async wallEdit(
    token: string,
    externalId: string,
    postId: number,
    message: string,
    attachmentRefs: string[] = [],
  ): Promise<void> {
    await this.call('wall.edit', token, {
      owner_id: this.wallOwnerId(externalId),
      post_id: String(postId),
      message,
      attachments: attachmentRefs.join(','),
    });
  }

  /** Same VK-side restriction as wallEdit above — see its comment. */
  async wallDelete(
    token: string,
    externalId: string,
    postId: number,
  ): Promise<void> {
    await this.call('wall.delete', token, {
      owner_id: this.wallOwnerId(externalId),
      post_id: String(postId),
    });
  }

  /** Uploads a photo or document and returns its wall-attachment reference (e.g. "photo-123_456"). */
  async uploadAttachment(
    token: string,
    externalId: string,
    input: VkAttachmentInput,
  ): Promise<string> {
    return input.kind === 'photo'
      ? this.uploadPhoto(token, externalId, input)
      : this.uploadDoc(token, externalId, input);
  }

  private async uploadPhoto(
    token: string,
    externalId: string,
    input: VkAttachmentInput,
  ): Promise<string> {
    const { upload_url } = await this.call<{ upload_url: string }>(
      'photos.getWallUploadServer',
      token,
      { group_id: externalId },
    );
    const uploaded = await this.postFile<{
      server: number;
      photo: string;
      hash: string;
    }>(upload_url, 'photo', input);
    const saved = await this.call<{ id: number; owner_id: number }[]>(
      'photos.saveWallPhoto',
      token,
      {
        group_id: externalId,
        server: String(uploaded.server),
        photo: uploaded.photo,
        hash: uploaded.hash,
      },
    );
    const photo = saved[0];
    if (!photo) {
      throw new VkApiError(0, 'VK не сохранил загруженное фото');
    }
    return `photo${photo.owner_id}_${photo.id}`;
  }

  private async uploadDoc(
    token: string,
    externalId: string,
    input: VkAttachmentInput,
  ): Promise<string> {
    const { upload_url } = await this.call<{ upload_url: string }>(
      'docs.getWallUploadServer',
      token,
      { group_id: externalId },
    );
    const uploaded = await this.postFile<{ file: string }>(
      upload_url,
      'file',
      input,
    );
    const saved = await this.call<{
      doc?: { id: number; owner_id: number };
    }>('docs.save', token, { file: uploaded.file, title: input.filename });
    if (!saved.doc) {
      throw new VkApiError(0, 'VK не сохранил загруженный документ');
    }
    return `doc${saved.doc.owner_id}_${saved.doc.id}`;
  }

  /** VK's upload servers aren't `api.vk.com/method/*` calls — they return raw JSON, not the `{response: ...}` envelope. */
  private async postFile<T>(
    uploadUrl: string,
    fieldName: string,
    input: VkAttachmentInput,
  ): Promise<T> {
    const form = new FormData();
    form.append(
      fieldName,
      // Buffer is a Uint8Array and Blob accepts it fine at runtime; the cast
      // only works around TS's BlobPart type being narrower (ArrayBuffer,
      // not ArrayBufferLike) than what Node's Buffer type declares.
      new Blob([input.buffer as unknown as ArrayBuffer], {
        type: input.mimeType,
      }),
      input.filename,
    );
    const res = await fetch(uploadUrl, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new VkApiError(0, `Загрузка файла в VK вернула HTTP ${res.status}`);
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new VkApiError(
        0,
        'VK вернул нераспознаваемый ответ при загрузке файла',
      );
    }
    if (typeof body !== 'object' || body === null) {
      throw new VkApiError(
        0,
        'Неожиданный формат ответа при загрузке файла в VK',
      );
    }
    return body as T;
  }

  private wallOwnerId(externalId: string): string {
    return String(-Math.abs(Number(externalId)));
  }
}
