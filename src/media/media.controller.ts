import {
  Controller,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { AppException } from '../common/app-exception';
import { ErrorCode } from '../common/error-code.enum';
import { MAX_FILE_BYTES, MediaService } from './media.service';

// No permission guards yet — Step 9, like the other controllers.
@Controller('media')
export class MediaController {
  constructor(private readonly mediaService: MediaService) {}

  @Post()
  @UseInterceptors(
    FileInterceptor('file', {
      // In memory rather than multer's own disk storage: MediaStorageService
      // owns the layout on disk (generated names, sharding, checksums), and
      // letting multer write files too would put that in two places.
      storage: memoryStorage(),
      // Enforced here as well as in the service so an oversized upload is
      // rejected while streaming, instead of after buffering all of it.
      limits: { fileSize: MAX_FILE_BYTES },
    }),
  )
  uploadFile(@UploadedFile() file?: Express.Multer.File) {
    if (!file) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'Файл не передан: ожидается поле «file» в multipart-форме',
      );
    }
    return this.mediaService.upload({
      // Multer decodes the filename as latin1; without this a Cyrillic name
      // arrives mangled, and it's the name the recipient of a document sees.
      filename: Buffer.from(file.originalname, 'latin1').toString('utf8'),
      buffer: file.buffer,
      declaredMimeType: file.mimetype,
    });
  }
}
