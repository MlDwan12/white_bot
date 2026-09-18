import { Injectable } from '@nestjs/common';
import { Group, Post } from '../generated/prisma/client';
import { TokenEncryptionService } from '../common/crypto/token-encryption.service';
import { VkApiClient } from '../vk/vk-api.client';
import { MaxApiClient } from '../max/max-api.client';

export interface SendResult {
  /** VK post id or MAX message id — required later for edit/delete. */
  externalMessageId: string;
}

/**
 * Publishes one post into one group, hiding the platform difference from the
 * delivery worker so the worker only has to deal with success or failure.
 *
 * Attachments are deliberately absent: Step 6a covers text only, and VK needs
 * every file uploaded separately per community, which is its own sub-step.
 */
@Injectable()
export class PostSender {
  constructor(
    private readonly vk: VkApiClient,
    private readonly max: MaxApiClient,
    private readonly tokenEncryption: TokenEncryptionService,
  ) {}

  async send(post: Post, group: Group): Promise<SendResult> {
    return group.platform === 'vk'
      ? this.sendToVk(post, group)
      : this.sendToMax(post, group);
  }

  /**
   * Per-platform override first, shared text otherwise — the rule that lets
   * one post serve both "same text everywhere" and "tailored per platform"
   * without being two entities.
   */
  static resolveText(post: Post, platform: Group['platform']): string {
    const override =
      platform === 'vk' ? post.vkTextOverride : post.maxTextOverride;
    return override ?? post.text;
  }

  private async sendToVk(post: Post, group: Group): Promise<SendResult> {
    if (!group.accessTokenEncrypted) {
      // The DB CHECK constraint from Step 3 makes this unreachable; treated as
      // a plain error (never retried) rather than silently skipped.
      throw new Error(`У VK-группы ${group.id} нет токена`);
    }
    const token = this.tokenEncryption.decrypt(group.accessTokenEncrypted);
    const { postId } = await this.vk.wallPost(
      token,
      group.externalId,
      PostSender.resolveText(post, 'vk'),
    );
    return { externalMessageId: String(postId) };
  }

  private async sendToMax(post: Post, group: Group): Promise<SendResult> {
    const { messageId } = await this.max.sendMessageToChat(
      Number(group.externalId),
      PostSender.resolveText(post, 'max'),
    );
    return { externalMessageId: messageId };
  }
}
