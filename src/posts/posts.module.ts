import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { CryptoModule } from '../common/crypto/crypto.module';
import { VkModule } from '../vk/vk.module';
import { MaxModule } from '../max/max.module';
import { MediaModule } from '../media/media.module';
import { QueueModule } from '../queue/queue.module';
import { ContestsModule } from '../contests/contests.module';
import { PostsController } from './posts.controller';
import { PostTemplatesController } from './post-templates.controller';
import { PostsService } from './posts.service';
import { PostTemplatesService } from './post-templates.service';
import { PostSender } from './post-sender';
import { AttachmentUploader } from './attachment-uploader';
import { PostDeliveryProcessor } from './post-delivery.processor';
import { PostReconcilerService } from './post-reconciler.service';
import { PostModerationService } from './post-moderation.service';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [
    AuthModule,
    PrismaModule,
    CryptoModule,
    VkModule,
    MaxModule,
    MediaModule,
    // QueueModule is global and already registers the delivery queue; a
    // second registerQueue here would build a second Queue instance (and a
    // second set of Redis connections) behind the same token.
    QueueModule,
    // Только за `ContestsService` — авто-открытие/авто-розыгрыш конкурсов
    // по датам живёт в общей сверке `PostReconcilerService`, не в своём
    // отдельном таймере (см. комментарий там же).
    ContestsModule,
  ],
  controllers: [PostsController, PostTemplatesController],
  providers: [
    PostsService,
    PostTemplatesService,
    PostSender,
    AttachmentUploader,
    PostDeliveryProcessor,
    PostReconcilerService,
    PostModerationService,
  ],
  // AttachmentUploader is exported for DirectMessagesModule, which needs the
  // same MAX-upload cache the campaign pipeline uses — building a second
  // instance would need its own copy of VkModule/MediaModule wiring for a
  // VK path direct messages never take.
  exports: [
    PostsService,
    PostTemplatesService,
    PostModerationService,
    AttachmentUploader,
  ],
})
export class PostsModule {}
