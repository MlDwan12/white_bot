import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { TokenEncryptionService } from '../common/crypto/token-encryption.service';
import { VkApiClient } from '../vk/vk-api.client';
import { GroupsController } from './groups.controller';
import { GroupsService } from './groups.service';
import {
  ManualVkTokenProvider,
  VK_TOKEN_PROVIDER,
} from './token-provider/vk-token.provider';

@Module({
  imports: [PrismaModule],
  controllers: [GroupsController],
  providers: [
    GroupsService,
    VkApiClient,
    TokenEncryptionService,
    { provide: VK_TOKEN_PROVIDER, useClass: ManualVkTokenProvider },
  ],
  exports: [GroupsService],
})
export class GroupsModule {}
