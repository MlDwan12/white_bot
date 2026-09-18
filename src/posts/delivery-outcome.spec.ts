import { VkApiError } from '../vk/vk-api.error';
import { MaxApiError } from '../max/max-api.error';
import { classifyDeliveryError } from './delivery-outcome';

describe('classifyDeliveryError', () => {
  describe('VK', () => {
    it('retries only an explicit rate limit', () => {
      expect(
        classifyDeliveryError(new VkApiError(6, 'Too many requests')),
      ).toMatchObject({ kind: 'retryable' });
      expect(
        classifyDeliveryError(new VkApiError(29, 'Rate limit')),
      ).toMatchObject({
        kind: 'retryable',
      });
    });

    it.each([
      [10, 'Internal server error'],
      [1, 'Unknown error'],
      [0, 'VK API вернул HTTP 502'],
    ])(
      'treats code %i as ambiguous rather than retrying a possible duplicate',
      (code, message) => {
        // The request may have been processed before the answer was lost.
        // Retrying would publish the post twice, and VK's wall.delete is
        // unavailable to undo it — so a human decides.
        expect(
          classifyDeliveryError(new VkApiError(code, message)),
        ).toMatchObject({
          kind: 'ambiguous',
        });
      },
    );

    it.each([5, 15, 27, 214, 220])(
      'disables the group on access failure %i instead of retrying',
      (code) => {
        expect(
          classifyDeliveryError(new VkApiError(code, 'Access denied')),
        ).toEqual({
          kind: 'permanent',
          message: 'Access denied',
          groupProblem: 'token_invalid',
        });
      },
    );

    it('does not retry flood control, which retrying makes worse', () => {
      expect(
        classifyDeliveryError(new VkApiError(9, 'Flood control')),
      ).toMatchObject({
        kind: 'permanent',
      });
      expect(
        classifyDeliveryError(new VkApiError(9, 'Flood control')),
      ).not.toHaveProperty('groupProblem');
    });

    it('treats an unrecognised VK code as a rejection, not as retryable', () => {
      expect(
        classifyDeliveryError(new VkApiError(100, 'Bad parameter')),
      ).toMatchObject({ kind: 'permanent' });
    });
  });

  describe('MAX', () => {
    it('retries a 429 and nothing else', () => {
      expect(
        classifyDeliveryError(new MaxApiError(429, 'too.many', 'Slow down')),
      ).toMatchObject({ kind: 'retryable' });
    });

    it('does not blame the group for an invalid bot token', () => {
      // One token serves every MAX chat, so flagging this group would
      // mislabel an app-wide problem as that chat's fault.
      const outcome = classifyDeliveryError(
        new MaxApiError(401, 'verify.token', 'Invalid token'),
      );

      expect(outcome).toMatchObject({ kind: 'permanent' });
      expect(outcome).not.toHaveProperty('groupProblem');
    });

    it.each([403, 404])('marks the group bot_removed on %i', (status) => {
      expect(
        classifyDeliveryError(
          new MaxApiError(status, 'forbidden', 'No access'),
        ),
      ).toEqual({
        kind: 'permanent',
        message: 'No access',
        groupProblem: 'bot_removed',
      });
    });

    it.each([0, 500, 502, 503])('treats %i as ambiguous', (status) => {
      expect(
        classifyDeliveryError(new MaxApiError(status, 'x', 'Boom')),
      ).toMatchObject({ kind: 'ambiguous' });
    });

    it('does not retry a plain rejection', () => {
      expect(
        classifyDeliveryError(new MaxApiError(400, 'bad.request', 'Bad')),
      ).toMatchObject({ kind: 'permanent' });
    });
  });

  it('treats an error from our own code as permanent — it never reached the network', () => {
    expect(classifyDeliveryError(new Error('нет токена'))).toEqual({
      kind: 'permanent',
      message: 'нет токена',
    });
  });

  it('survives a thrown non-Error', () => {
    expect(classifyDeliveryError('строка')).toMatchObject({
      kind: 'permanent',
    });
  });
});
