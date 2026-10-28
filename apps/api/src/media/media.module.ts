import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { MediaService } from './media.service';
import { MediaStorageService } from './media-storage.service';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule, PrismaModule],
  providers: [MediaService, MediaStorageService],
  exports: [MediaService, MediaStorageService],
})
export class MediaModule {}
