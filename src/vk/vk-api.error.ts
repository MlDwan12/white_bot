/** Wraps a VK API error response ({ error: { error_code, error_msg } }). */
export class VkApiError extends Error {
  constructor(
    public readonly code: number,
    message: string,
  ) {
    super(message);
  }
}
