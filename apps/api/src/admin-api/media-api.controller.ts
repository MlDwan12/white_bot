import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { memoryStorage } from 'multer';
import { AdminAuthGuard } from '../auth/admin-auth.guard';
import { CsrfGuard } from '../auth/csrf.guard';
import { AppException } from '../common/app-exception';
import { ErrorCode } from '../common/error-code.enum';
import { MAX_FILE_BYTES, MediaService } from '../media/media.service';
import type { Media, Wire } from '@white-bot/shared';

/**
 * Загрузка и превью вложений для React-панели. Право не требуется сверх
 * входа: файл ни к чему не привязывается, пока его не приложат к посту или
 * конкурсу — а там свои права.
 *
 * CSRF — гвардом: React шлёт токен заголовком, тело разбирать не нужно
 * (в старой панели токен лежал в multipart-теле, отсюда интерцептор там).
 */
@Controller('api/media')
@UseGuards(AdminAuthGuard, CsrfGuard)
export class MediaApiController {
  constructor(private readonly media: MediaService) {}

  @Post()
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: MAX_FILE_BYTES },
    }),
  )
  async upload(
    @UploadedFile() file: Express.Multer.File | undefined,
  ): Promise<Wire<Media>> {
    if (!file) {
      throw new AppException(ErrorCode.VALIDATION_ERROR, 'Файл не выбран');
    }
    const asset = await this.media.upload({
      buffer: file.buffer,
      // Multer отдаёт имя в latin1 — без перекодировки кириллица ломается.
      filename: Buffer.from(file.originalname, 'latin1').toString('utf8'),
      declaredMimeType: file.mimetype,
    });
    return { id: asset.id, filename: asset.filename, kind: asset.kind };
  }

  @Get(':id/preview')
  async preview(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('size') size: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const { buffer, mimeType } = await this.media.readPreview(
      id,
      size === 'full' ? 'full' : 'thumb',
    );
    res.set({
      'Content-Type': mimeType,
      'Cache-Control': 'private, max-age=86400',
      'X-Content-Type-Options': 'nosniff',
    });
    res.send(buffer);
  }
}
