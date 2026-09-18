import { Group, Post } from '../generated/prisma/client';
import { TokenEncryptionService } from '../common/crypto/token-encryption.service';
import { VkApiClient } from '../vk/vk-api.client';
import { MaxApiClient } from '../max/max-api.client';
import { PostSender } from './post-sender';

function post(overrides: Partial<Post> = {}): Post {
  return {
    text: 'общий текст',
    vkTextOverride: null,
    maxTextOverride: null,
    ...overrides,
  } as Post;
}

function group(overrides: Partial<Group> = {}): Group {
  return {
    id: 'g1',
    platform: 'vk',
    externalId: '123',
    accessTokenEncrypted: 'enc',
    ...overrides,
  } as Group;
}

function setup() {
  const vk = { wallPost: jest.fn().mockResolvedValue({ postId: 777 }) };
  const max = {
    sendMessageToChat: jest.fn().mockResolvedValue({ messageId: 'mid-9' }),
  };
  const tokenEncryption = { decrypt: jest.fn().mockReturnValue('plain-token') };

  const sender = new PostSender(
    vk as unknown as VkApiClient,
    max as unknown as MaxApiClient,
    tokenEncryption as unknown as TokenEncryptionService,
  );
  return { sender, vk, max, tokenEncryption };
}

describe('PostSender', () => {
  describe('resolveText', () => {
    it('falls back to the shared text when no override is set', () => {
      expect(PostSender.resolveText(post(), 'vk')).toBe('общий текст');
      expect(PostSender.resolveText(post(), 'max')).toBe('общий текст');
    });

    it('applies an override only to its own platform', () => {
      const p = post({ vkTextOverride: 'текст для VK' });

      expect(PostSender.resolveText(p, 'vk')).toBe('текст для VK');
      expect(PostSender.resolveText(p, 'max')).toBe('общий текст');
    });

    it('keeps an intentionally empty override rather than treating it as absent', () => {
      // Only null means "not set"; '' is a deliberate choice to post no text
      // on that platform.
      expect(PostSender.resolveText(post({ maxTextOverride: '' }), 'max')).toBe(
        '',
      );
    });
  });

  it('publishes to a VK wall with the decrypted community token', async () => {
    const { sender, vk, tokenEncryption } = setup();

    const result = await sender.send(post(), group());

    expect(tokenEncryption.decrypt).toHaveBeenCalledWith('enc');
    expect(vk.wallPost).toHaveBeenCalledWith(
      'plain-token',
      '123',
      'общий текст',
    );
    expect(result).toEqual({ externalMessageId: '777' });
  });

  it('fails loudly when a VK group somehow has no token', async () => {
    const { sender, vk } = setup();

    await expect(
      sender.send(post(), group({ accessTokenEncrypted: null })),
    ).rejects.toThrow(/нет токена/);
    expect(vk.wallPost).not.toHaveBeenCalled();
  });

  it('sends to a MAX chat by numeric id', async () => {
    const { sender, max } = setup();

    const result = await sender.send(
      post(),
      group({ platform: 'max', externalId: '500', accessTokenEncrypted: null }),
    );

    // MAX identifies chats numerically, while we store external ids as text.
    expect(max.sendMessageToChat).toHaveBeenCalledWith(500, 'общий текст');
    expect(result).toEqual({ externalMessageId: 'mid-9' });
  });
});
