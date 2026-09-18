import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { CryptoModule } from '../common/crypto/crypto.module';
import { VkModule } from '../vk/vk.module';
import { MaxModule } from '../max/max.module';
import { QueueModule } from '../queue/queue.module';
import { PostsController } from './posts.controller';
import { PostsService } from './posts.service';
import { PostSender } from './post-sender';
import { PostDeliveryProcessor } from './post-delivery.processor';
import { PostReconcilerService } from './post-reconciler.service';

@Module({
  imports: [
    PrismaModule,
    CryptoModule,
    VkModule,
    MaxModule,
    // QueueModule is global and already registers the delivery queue; a
    // second registerQueue here would build a second Queue instance (and a
    // second set of Redis connections) behind the same token.
    QueueModule,
  ],
  controllers: [PostsController],
  providers: [
    PostsService,
    PostSender,
    PostDeliveryProcessor,
    PostReconcilerService,
  ],
  exports: [PostsService],
})
export class PostsModule {}
