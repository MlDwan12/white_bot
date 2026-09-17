import { Injectable } from '@nestjs/common';
import { VkApiError } from './vk-api.error';

// Fixed explicitly rather than left to VK's default so a platform-side
// default bump can't silently change response shapes under us.
const VK_API_VERSION = '5.199';
const VK_API_BASE = 'https://api.vk.com/method';
const REQUEST_TIMEOUT_MS = 10_000;

export interface VkGroupInfo {
  externalId: string;
  title: string;
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
 * Thin client around VK's HTTP API. Deliberately narrow — only the two calls
 * Groups needs right now (validate a token + confirm connectivity). VK
 * content methods (wall.post/edit/delete for real campaigns) belong to the
 * VK-integration step, not here.
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
    await this.call('wall.post', token, {
      owner_id: String(-Math.abs(Number(externalId))),
      from_group: '1',
      message: '✅ Бот подключён',
    });
  }
}
