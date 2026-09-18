import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { MediaController } from './media.controller';
import { MediaService } from './media.service';
import { MediaStorageService } from './media-storage.service';

@Module({
  imports: [PrismaModule],
  controllers: [MediaController],
  providers: [MediaService, MediaStorageService],
  exports: [MediaService, MediaStorageService],
})
export class MediaModule {}
