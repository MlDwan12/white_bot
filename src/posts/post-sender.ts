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
   * Правит уже опубликованное сообщение.
   *
   * Вложения собираются **заново из текущего состояния поста**, а не
   * снимаются со старого сообщения: смысл правки в том числе в том, что
   * медиа могло измениться. В MAX это обязательно вдвойне — editMessage
   * заменяет сообщение целиком, и без вложений картинка исчезла бы.
   */
  async edit(
    post: Post,
    group: Group,
    externalMessageId: string,
    assets: MediaAsset[] = [],
    contestButton?: ContestButton | null,
  ): Promise<void> {
    return group.platform === 'vk'
      ? this.editInVk(post, group, externalMessageId, assets)
      : this.editInMax(post, group, externalMessageId, assets, contestButton);
  }

  /** Удаляет опубликованное сообщение из группы. */
  async delete(group: Group, externalMessageId: string): Promise<void> {
    if (group.platform === 'vk') {
      const token = this.requireVkToken(group);
      await this.vk.wallDelete(
        token,
        group.externalId,
        Number(externalMessageId),
      );
      return;
    }
    await this.max.deleteMessage(externalMessageId);
  }

  private async editInVk(
    post: Post,
    group: Group,
    externalMessageId: string,
    assets: MediaAsset[],
  ): Promise<void> {
    const attachmentRefs = await this.attachments.vkRefs(assets, group);
    const token = this.requireVkToken(group);
    await this.vk.wallEdit(
      token,
      group.externalId,
      Number(externalMessageId),
      PostSender.resolveText(post, 'vk'),
      attachmentRefs,
    );
  }

  private async editInMax(
    post: Post,
    group: Group,
    externalMessageId: string,
    assets: MediaAsset[],
    contestButton?: ContestButton | null,
  ): Promise<void> {
    const attachments = await this.attachments.maxAttachments(assets);
    // Кнопка передаётся заново вместе с текстом: в MAX клавиатура — такое же
    // вложение, и правка без неё снесла бы у анонса конкурса кнопку
    // «Участвовать» во всех группах разом. Никто бы уже не записался.
    await this.max.editMessage(
      externalMessageId,
      PostSender.resolveText(post, 'max'),
      { attachments, buttons: contestButtons(contestButton) },
    );
  }

  private requireVkToken(group: Group): string {
    if (!group.accessTokenEncrypted) {
      // Недостижимо из-за CHECK-ограничения в базе; обычная ошибка, а не
      // тихий пропуск.
      throw new Error(`У VK-группы ${group.id} нет токена`);
    }
    return this.tokenEncryption.decrypt(group.accessTokenEncrypted);
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
    // Uploads run on the personal token, the wall post on the community one —
    // VK forbids attachment uploads with a community token entirely (error 27).
    const attachmentRefs = await this.attachments.vkRefs(assets, group);
    const token = this.requireVkToken(group);
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
    const buttons = contestButtons(contestButton);
    const { messageId } = await this.max.sendMessageToChat(
      Number(group.externalId),
      PostSender.resolveText(post, 'max'),
      { attachments, buttons },
    );
    return { externalMessageId: messageId };
  }
}

/** Клавиатура с кнопкой участия — или ничего, если конкурса нет. */
function contestButtons(button?: ContestButton | null) {
  return button
    ? [
        [
          {
            type: 'callback' as const,
            text: button.label,
            payload: contestJoinPayload(button.contestId),
          },
        ],
      ]
    : undefined;
}
