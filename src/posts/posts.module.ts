import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { CryptoModule } from '../common/crypto/crypto.module';
import { VkModule } from '../vk/vk.module';
import { MaxModule } from '../max/max.module';
import { MediaModule } from '../media/media.module';
import { QueueModule } from '../queue/queue.module';
import { PostsController } from './posts.controller';
import { PostTemplatesController } from './post-templates.controller';
import { PostsService } from './posts.service';
import { PostTemplatesService } from './post-templates.service';
import { PostSender } from './post-sender';
import { AttachmentUploader } from './attachment-uploader';
import { PostDeliveryProcessor } from './post-delivery.processor';
import { PostReconcilerService } from './post-reconciler.service';

@Module({
  imports: [
    PrismaModule,
    CryptoModule,
    VkModule,
    MaxModule,
    MediaModule,
    // QueueModule is global and already registers the delivery queue; a
    // second registerQueue here would build a second Queue instance (and a
    // second set of Redis connections) behind the same token.
    QueueModule,
  ],
  controllers: [PostsController, PostTemplatesController],
  providers: [
    PostsService,
    PostTemplatesService,
    PostSender,
    AttachmentUploader,
    PostDeliveryProcessor,
    PostReconcilerService,
  ],
  exports: [PostsService, PostTemplatesService],
})
export class PostsModule {}
