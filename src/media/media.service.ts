import { Injectable } from '@nestjs/common';
import sharp from 'sharp';
import { PinoLogger } from 'nestjs-pino';
import { AppException } from '../common/app-exception';
import { ErrorCode } from '../common/error-code.enum';
import { PrismaService } from '../prisma/prisma.service';
import { MediaAsset, MediaKind } from '../generated/prisma/client';
import { MediaStorageService } from './media-storage.service';

/** Ceiling for a single upload. VK's own document limit is the binding one. */
export const MAX_FILE_BYTES = 50 * 1024 * 1024;

/**
 * Image formats we accept. Deliberately narrow: sharp reads far more (svg,
 * tiff, avif…), but SVG is a script-carrying format and the rest aren't
 * reliably accepted by VK/MAX, so they're treated as documents instead.
 */
const ACCEPTED_IMAGE_FORMATS = new Set(['jpeg', 'png', 'gif', 'webp']);

const IMAGE_MIME: Record<string, string> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
};

const IMAGE_EXTENSION: Record<string, string> = {
  jpeg: 'jpg',
  png: 'png',
  gif: 'gif',
  webp: 'webp',
};

export interface UploadInput {
  filename: string;
  buffer: Buffer;
  /** From the multipart body — untrusted, used only as a fallback for documents. */
  declaredMimeType?: string;
}

@Injectable()
export class MediaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: MediaStorageService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(MediaService.name);
  }

  async upload(input: UploadInput): Promise<MediaAsset> {
    if (input.buffer.byteLength === 0) {
      throw new AppException(ErrorCode.VALIDATION_ERROR, 'Файл пуст');
    }
    if (input.buffer.byteLength > MAX_FILE_BYTES) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        `Файл больше ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} МБ`,
      );
    }

    // Тот же файл под тем же именем — не новая загрузка. Панель отвечает на
    // загрузку страницей, а не редиректом, поэтому обновление страницы
    // отправляет форму повторно; без этой проверки каждое обновление плодило
    // бы копию файла в хранилище и в списке вложений. Имя входит в условие
    // намеренно: его видит получатель документа, и подсовывать старое имя
    // тому, кто загрузил тот же файл под новым, нельзя.
    const checksum = MediaStorageService.checksum(input.buffer);
    const existing = await this.prisma.mediaAsset.findFirst({
      where: {
        checksum,
        filename: input.filename,
        sizeBytes: input.buffer.byteLength,
      },
      orderBy: { createdAt: 'asc' },
    });
    if (existing) {
      return existing;
    }

    const image = await MediaService.probeImage(input.buffer);
    const kind: MediaKind = image ? 'image' : 'document';
    const mimeType = image
      ? IMAGE_MIME[image.format]
      : (input.declaredMimeType ?? 'application/octet-stream');
    const extension = image
      ? IMAGE_EXTENSION[image.format]
      : MediaService.extensionOf(input.filename);

    const stored = await this.storage.write(input.buffer, extension);
    const optimized = image
      ? await this.tryOptimize(input.buffer, image.format)
      : null;

    try {
      return await this.prisma.mediaAsset.create({
        data: {
          filename: input.filename,
          kind,
          mimeType,
          sizeBytes: input.buffer.byteLength,
          checksum,
          storagePath: stored.relativePath,
          optimizedPath: optimized?.relativePath ?? null,
          optimizedSizeBytes: optimized?.sizeBytes ?? null,
        },
      });
    } catch (err: unknown) {
      // The bytes are already on disk, and nothing would ever reference them:
      // no row means no path to find them by, and the upload is reported as
      // failed. Removing them here keeps a failing database from slowly
      // filling the volume with files nobody can reach.
      await this.discard(stored.relativePath, optimized?.relativePath);
      throw err;
    }
  }

  private async discard(...paths: (string | undefined)[]): Promise<void> {
    for (const relativePath of paths) {
      if (!relativePath) continue;
      await this.storage
        .remove(relativePath)
        .catch((err: unknown) =>
          this.logger.warn(
            { err, relativePath },
            'Не удалось удалить файл после неудачной записи в БД',
          ),
        );
    }
  }

  /**
   * Bytes to publish: the optimized variant when there is one, the original
   * otherwise. Callers never decide this themselves, so an asset without an
   * optimized copy behaves exactly like one with it.
   */
  async readForUpload(asset: MediaAsset): Promise<Buffer> {
    return this.storage.read(this.relativePathForUpload(asset));
  }

  /**
   * Runs `use` with a path that carries the asset's *original* file name.
   *
   * The MAX SDK takes the displayed name from its source: a Buffer gets a
   * random uuid with no extension, and our storage path gets the generated
   * uuid name. Neither is what the recipient of a document should see, so the
   * bytes are exposed briefly under their real name instead.
   */
  async withUploadPath<T>(
    asset: MediaAsset,
    use: (path: string) => Promise<T>,
  ): Promise<T> {
    return this.storage.withNamedPath(
      this.relativePathForUpload(asset),
      asset.filename,
      use,
    );
  }

  private relativePathForUpload(asset: MediaAsset): string {
    return asset.optimizedPath ?? asset.storagePath;
  }

  /**
   * Identifies an image by its actual content. The multipart `Content-Type` is
   * attacker-controlled and cannot decide whether we re-encode a file, so it's
   * ignored here — sharp either parses the bytes as an image or it doesn't.
   */
  private static async probeImage(
    buffer: Buffer,
  ): Promise<{ format: string } | null> {
    try {
      const metadata = await sharp(buffer).metadata();
      const format = metadata.format;
      return format && ACCEPTED_IMAGE_FORMATS.has(format) ? { format } : null;
    } catch {
      // Not an image sharp can read — treated as a document, bytes untouched.
      return null;
    }
  }

  /**
   * Lossless re-compression, images only, and only for formats where that is
   * actually possible.
   *
   * PNG is a lossless format, so re-encoding it at maximum effort reproduces
   * the exact same pixels in fewer bytes. JPEG is not: any re-encode decodes
   * and re-compresses, losing a little quality every time — "quality: 100"
   * included. GIF re-encoding re-quantizes the palette. Since the requirement
   * was explicitly *without* quality loss, those formats are stored untouched
   * rather than quietly degraded.
   *
   * Documents never reach this method at all: a .docx or .pdf must arrive
   * byte-identical, and re-encoding would corrupt it outright.
   */
  private async tryOptimize(
    buffer: Buffer,
    format: string,
  ): Promise<{ relativePath: string; sizeBytes: number } | null> {
    if (format !== 'png') {
      return null;
    }

    try {
      const optimized = await sharp(buffer)
        // `palette: false` keeps the full colour data: palette quantisation
        // would shrink the file by throwing colours away, which is lossy.
        .png({ compressionLevel: 9, effort: 10, palette: false })
        .toBuffer();

      // A bigger "optimized" copy is worse than none: it would waste disk and
      // upload time for nothing.
      if (optimized.byteLength >= buffer.byteLength) {
        return null;
      }
      return this.storage.write(optimized, 'png');
    } catch (err: unknown) {
      // Optimisation is a nicety; failing it must not fail the upload.
      this.logger.warn({ err }, 'Не удалось оптимизировать изображение');
      return null;
    }
  }

  private static extensionOf(filename: string): string {
    const match = /\.([A-Za-z0-9]{1,8})$/.exec(filename);
    return match ? match[1] : '';
  }
}
