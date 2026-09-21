import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { QueueModule } from '../queue/queue.module';
import { MaxModule } from '../max/max.module';
import { DirectMessageRecipientsService } from './direct-message-recipients.service';
import { DirectMessageDispatchService } from './direct-message-dispatch.service';
import { DirectMessageSenderProcessor } from './direct-message-sender.processor';

@Module({
  imports: [
    PrismaModule,
    // QueueModule is global and already registers the direct-message queue;
    // a second registerQueue here would build a second Queue instance behind
    // the same token, same reasoning as PostsModule's comment.
    QueueModule,
    MaxModule,
  ],
  providers: [
    DirectMessageRecipientsService,
    DirectMessageDispatchService,
    DirectMessageSenderProcessor,
  ],
  exports: [DirectMessageRecipientsService, DirectMessageDispatchService],
})
export class DirectMessagesModule {}
