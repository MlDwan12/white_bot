import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { CryptoModule } from '../common/crypto/crypto.module';
import { VkApiClient } from './vk-api.client';
import { VkOAuthController } from './vk-oauth.controller';
import { VkUploaderTokenService } from './vk-uploader-token.service';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule, PrismaModule, CryptoModule],
  controllers: [VkOAuthController],
  providers: [VkApiClient, VkUploaderTokenService],
  exports: [VkApiClient, VkUploaderTokenService],
})
export class VkModule {}
