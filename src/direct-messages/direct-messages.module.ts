import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { DirectMessageRecipientsService } from './direct-message-recipients.service';

@Module({
  imports: [PrismaModule],
  providers: [DirectMessageRecipientsService],
  exports: [DirectMessageRecipientsService],
})
export class DirectMessagesModule {}
