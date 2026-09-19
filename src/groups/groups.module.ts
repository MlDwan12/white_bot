import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { CryptoModule } from '../common/crypto/crypto.module';
import { VkModule } from '../vk/vk.module';
import { GroupsController } from './groups.controller';
import { GroupsService } from './groups.service';
import {
  ManualVkTokenProvider,
  VK_TOKEN_PROVIDER,
} from './token-provider/vk-token.provider';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule, PrismaModule, CryptoModule, VkModule],
  controllers: [GroupsController],
  providers: [
    GroupsService,
    { provide: VK_TOKEN_PROVIDER, useClass: ManualVkTokenProvider },
  ],
  exports: [GroupsService],
})
export class GroupsModule {}
