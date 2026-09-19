import { Injectable } from '@nestjs/common';
import { Group, MediaAsset, Post } from '../generated/prisma/client';
import { AttachmentUploader } from './attachment-uploader';
import { TokenEncryptionService } from '../common/crypto/token-encryption.service';
import { VkApiClient } from '../vk/vk-api.client';
import { MaxApiClient } from '../max/max-api.client';
import { contestJoinPayload } from '../contests/contest-button';

/**
 * Конкурс, чья кнопка участия вшивается в сообщение. Передаётся сюда, а не
 * читается из базы: PostSender намеренно не знает про Prisma, вся загрузка
 * данных остаётся в процессоре доставки.
 */
export interface ContestButton {
  contestId: string;
  label: string;
}

export interface SendResult {
  /** VK post id or MAX message id — required later for edit/delete. */
  externalMessageId: string;
}

/**
 * Publishes one post into one group, hiding the platform difference from the
 * delivery worker so the worker only has to deal with success or failure.
 *
 * Attachment uploading happens here rather than once per campaign because VK
 * requires a separate upload into every community; AttachmentUploader caches
 * the resulting references so repeated deliveries don't repeat the work.
 */
@Injectable()
export class PostSender {
  constructor(
    private readonly vk: VkApiClient,
    private readonly max: MaxApiClient,
    private readonly tokenEncryption: TokenEncryptionService,
    private readonly attachments: AttachmentUploader,
  ) {}

  async send(
    post: Post,
    group: Group,
    assets: MediaAsset[] = [],
    contestButton?: ContestButton | null,
  ): Promise<SendResult> {
    return group.platform === 'vk'
      ? // У VK постов на стене кнопок не бывает в принципе — клавиатуры там
        // живут только в сообщениях, поэтому конкурс сюда не доезжает.
        this.sendToVk(post, group, assets)
      : this.sendToMax(post, group, assets, contestButton);
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

  private async sendToVk(
    post: Post,
    group: Group,
    assets: MediaAsset[],
  ): Promise<SendResult> {
    if (!group.accessTokenEncrypted) {
      // The DB CHECK constraint from Step 3 makes this unreachable; treated as
      // a plain error (never retried) rather than silently skipped.
      throw new Error(`У VK-группы ${group.id} нет токена`);
    }
    // Uploads run on the personal token, the wall post on the community one —
    // VK forbids attachment uploads with a community token entirely (error 27).
    const attachmentRefs = await this.attachments.vkRefs(assets, group);
    const token = this.tokenEncryption.decrypt(group.accessTokenEncrypted);
    const { postId } = await this.vk.wallPost(
      token,
      group.externalId,
      PostSender.resolveText(post, 'vk'),
      attachmentRefs,
    );
    return { externalMessageId: String(postId) };
  }

  private async sendToMax(
    post: Post,
    group: Group,
    assets: MediaAsset[],
    contestButton?: ContestButton | null,
  ): Promise<SendResult> {
    const attachments = await this.attachments.maxAttachments(assets);
    const buttons = contestButton
      ? [
          [
            {
              type: 'callback' as const,
              text: contestButton.label,
              payload: contestJoinPayload(contestButton.contestId),
            },
          ],
        ]
      : undefined;
    const { messageId } = await this.max.sendMessageToChat(
      Number(group.externalId),
      PostSender.resolveText(post, 'max'),
      { attachments, buttons },
    );
    return { externalMessageId: messageId };
  }
}
