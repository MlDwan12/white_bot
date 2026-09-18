import { GroupStatus } from '../generated/prisma/client';
import { VkApiError } from '../vk/vk-api.error';
import { MaxApiError } from '../max/max-api.error';

/**
 * What to do with a failed delivery.
 *
 * Three outcomes, not two, and the reason is duplicate posts. A network error
 * almost never proves the post wasn't published: if `wall.post` reached VK,
 * VK accepted it, and only the *response* was lost, retrying publishes the
 * same thing a second time in a real community — and we cannot delete it
 * (VK's wall.delete is still blocked on their manual approval).
 *
 * So only an explicit rate-limit counts as retryable: there the platform
 * states it refused to act. Timeouts, dropped connections and 5xx are
 * `ambiguous` — the delivery goes to `unknown` and an admin decides, exactly
 * the mechanism PLAN.md already describes ("Отметить отправленным" /
 * "Отправить заново"). Fewer duplicates, more manual work: a deliberate
 * trade, chosen because a duplicate is unfixable and manual work isn't.
 */
export type DeliveryOutcome =
  | { kind: 'retryable'; message: string }
  | { kind: 'permanent'; message: string; groupProblem?: GroupStatus }
  | { kind: 'ambiguous'; message: string };

/**
 * VK error codes. VK answers with HTTP 200 and an `error` object, so these
 * numbers — not the HTTP status — carry the meaning.
 * See https://dev.vk.com/ru/reference/errors.
 */
const VK_RATE_LIMITED = new Set([
  6, // Too many requests per second
  29, // Rate limit reached
]);

/** Codes that mean the token/permissions are wrong, not that the call was unlucky. */
const VK_ACCESS_DENIED = new Set([
  5, // User authorization failed
  15, // Access denied
  27, // Group authorization failed
  214, // Access to adding post denied
  220, // Access to status denied
]);

const VK_AMBIGUOUS = new Set([
  1, // Unknown error occurred
  10, // Internal server error
]);

export function classifyDeliveryError(err: unknown): DeliveryOutcome {
  if (err instanceof VkApiError) {
    return classifyVkError(err);
  }
  if (err instanceof MaxApiError) {
    return classifyMaxError(err);
  }
  // An error from our own code (a bug, a missing group token) rather than from
  // the platform. It never reached the network, so nothing was published and
  // retrying would just repeat the bug.
  return {
    kind: 'permanent',
    message: err instanceof Error ? err.message : 'Неизвестная ошибка доставки',
  };
}

function classifyVkError(err: VkApiError): DeliveryOutcome {
  if (VK_RATE_LIMITED.has(err.code)) {
    return { kind: 'retryable', message: err.message };
  }
  if (VK_ACCESS_DENIED.has(err.code)) {
    return {
      kind: 'permanent',
      message: err.message,
      groupProblem: 'token_invalid',
    };
  }
  // Code 9 is flood control: VK rejected the call, so nothing was published —
  // but it fires on repeated/duplicate content, and retrying is what triggers
  // it harder. Treated as permanent so the campaign stops poking VK.
  if (err.code === 9) {
    return { kind: 'permanent', message: err.message };
  }
  if (VK_AMBIGUOUS.has(err.code)) {
    return { kind: 'ambiguous', message: err.message };
  }
  // Code 0 is our own client's marker for a transport failure or a non-2xx
  // HTTP response (a proxy, an outage page) — the request may well have been
  // delivered and processed before the answer got lost.
  if (err.code === 0) {
    return { kind: 'ambiguous', message: err.message };
  }
  // Any other VK code is a rejection VK could explain: a malformed request, a
  // missing parameter. Retrying an unchanged request cannot help.
  return { kind: 'permanent', message: err.message };
}

function classifyMaxError(err: MaxApiError): DeliveryOutcome {
  if (err.status === 429) {
    return { kind: 'retryable', message: err.message };
  }
  if (err.tokenInvalid) {
    // One bot token serves every MAX chat, so an invalid token is not this
    // group's fault — flagging the group would mislabel a global problem.
    return { kind: 'permanent', message: err.message };
  }
  if (err.status === 403 || err.status === 404) {
    // The bot was kicked out, or the chat is gone.
    return {
      kind: 'permanent',
      message: err.message,
      groupProblem: 'bot_removed',
    };
  }
  // Status 0 is our adapter's marker for a transport failure; 5xx means MAX
  // answered but may still have processed the message first.
  if (err.status === 0 || err.status >= 500) {
    return { kind: 'ambiguous', message: err.message };
  }
  return { kind: 'permanent', message: err.message };
}
