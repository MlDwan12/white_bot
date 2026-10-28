import sharp from 'sharp';
import { PinoLogger } from 'nestjs-pino';
import { AppException } from '../common/app-exception';
import { PrismaService } from '../prisma/prisma.service';
import { MediaService } from './media.service';
import { MediaStorageService } from './media-storage.service';

/** A noisy image, so compression gains aren't an artefact of flat colour. */
async function makeImage(
  format: 'png' | 'jpeg' | 'gif',
  width = 120,
  height = 90,
): Promise<Buffer> {
  const raw = Buffer.alloc(width * height * 3);
  for (let i = 0; i < raw.length; i++) {
    raw[i] = (Math.sin(i * 0.37) * 127 + 128) | 0;
  }
  const image = sharp(raw, { raw: { width, height, channels: 3 } });
  if (format === 'png') return image.png({ compressionLevel: 6 }).toBuffer();
  if (format === 'jpeg') return image.jpeg({ quality: 90 }).toBuffer();
  return image.gif().toBuffer();
}

/**
 * A minimal, genuinely valid MP4 `ftyp` box — enough for `file-type` to
 * identify it by content, the same distrust-the-label principle `makeImage`
 * serves for images. Not a playable video, just a correct signature.
 */
function makeVideo(): Buffer {
  return Buffer.concat([
    Buffer.from([0, 0, 0, 0x18]),
    Buffer.from('ftyp', 'ascii'),
    Buffer.from('isom', 'ascii'),
    Buffer.from([0, 0, 0, 0]),
    Buffer.from('isomiso2', 'ascii'),
  ]);
}

/**
 * A minimal, genuinely valid EBML/webm header — enough for `file-type`'s
 * `DocType` scan to identify it as `video/webm` by content. mp4 and webm are
 * detected by two entirely different signatures (`ftyp` box vs. EBML), and
 * the reported bug ("a real .webm still uploads as a document") was specific
 * to webm, so this exercises that path directly rather than trusting the mp4
 * case above to stand in for it.
 */
function makeWebm(): Buffer {
  return Buffer.from([
    0x1a,
    0x45,
    0xdf,
    0xa3, // EBML root element id
    0x87, // root length (var-int, value 7)
    0x42,
    0x82, // DocType element id
    0x84, // DocType length (var-int, value 4)
    0x77,
    0x65,
    0x62,
    0x6d, // "webm"
  ]);
}

function setup() {
  const written: { buffer: Buffer; extension: string }[] = [];
  const storage = {
    write: jest.fn((buffer: Buffer, extension: string) => {
      written.push({ buffer, extension });
      return Promise.resolve({
        relativePath: `p${written.length}`,
        sizeBytes: buffer.byteLength,
      });
    }),
    read: jest.fn(),
    remove: jest.fn().mockResolvedValue(undefined),
  };
  const prisma = {
    mediaAsset: {
      create: jest.fn(({ data }: { data: object }) => Promise.resolve(data)),
      // По умолчанию такого файла ещё нет — обычная новая загрузка.
      findFirst: jest.fn().mockResolvedValue(null),
      findUnique: jest.fn(),
      update: jest.fn(({ data }: { data: object }) => Promise.resolve(data)),
    },
  };
  const logger = { setContext: jest.fn(), warn: jest.fn() };

  const service = new MediaService(
    prisma as unknown as PrismaService,
    storage as unknown as MediaStorageService,
    logger as unknown as PinoLogger,
  );
  return { service, prisma, storage, written, logger };
}

/** The row MediaService asked Prisma to create. */
function createdAsset(prisma: {
  mediaAsset: { create: jest.Mock; findFirst: jest.Mock };
}) {
  const calls = prisma.mediaAsset.create.mock.calls as unknown[][];
  return (calls[0][0] as { data: Record<string, unknown> }).data;
}

describe('MediaService', () => {
  describe('повторная загрузка', () => {
    it('тот же файл под тем же именем возвращает уже загруженный, не плодя копию', async () => {
      // Панель отвечает на загрузку страницей, а не редиректом, и обновление
      // страницы отправляет форму повторно: без этого каждое обновление
      // добавляло бы копию файла в хранилище и в список вложений.
      const { service, prisma, storage } = setup();
      const existing = { id: 'asset-1', filename: 'договор.txt' };
      prisma.mediaAsset.findFirst.mockResolvedValue(existing);

      const result = await service.upload({
        filename: 'договор.txt',
        buffer: Buffer.from('одно и то же'),
      });

      expect(result).toBe(existing);
      expect(prisma.mediaAsset.create).not.toHaveBeenCalled();
      expect(storage.write).not.toHaveBeenCalled();
    });

    it('переопределяет вид на video, если старая запись застряла на document', async () => {
      // До появления вида `video` (или из-за более раннего бага) тот же
      // файл мог осесть в базе как документ; без реклассификации дедуп
      // отдавал бы эту запись безусловно, и она никогда не стала бы видео,
      // сколько раз её ни перезагружай — именно так выглядел баг,
      // обнаруженный пользователем на реальном `.webm`.
      const { service, prisma } = setup();
      const existing = {
        id: 'asset-1',
        filename: 'ролик.bin',
        kind: 'document',
      };
      prisma.mediaAsset.findFirst.mockResolvedValue(existing);

      const result = await service.upload({
        filename: 'ролик.bin',
        buffer: makeVideo(),
      });

      expect(prisma.mediaAsset.update).toHaveBeenCalledWith({
        where: { id: 'asset-1' },
        data: { kind: 'video', mimeType: 'video/mp4' },
      });
      expect(result).toMatchObject({ kind: 'video', mimeType: 'video/mp4' });
    });

    it('оставляет старую запись document как есть, если содержимое и правда не видео', async () => {
      const { service, prisma } = setup();
      const existing = {
        id: 'asset-1',
        filename: 'отчёт.pdf',
        kind: 'document',
      };
      prisma.mediaAsset.findFirst.mockResolvedValue(existing);

      const result = await service.upload({
        filename: 'отчёт.pdf',
        buffer: Buffer.from('%PDF-1.4 не настоящий pdf'),
      });

      expect(prisma.mediaAsset.update).not.toHaveBeenCalled();
      expect(result).toBe(existing);
    });

    it('ищет по содержимому и имени вместе, а не только по содержимому', async () => {
      // Имя видит получатель документа: тому, кто загрузил тот же файл под
      // новым именем, нельзя отдавать запись со старым.
      const { service, prisma } = setup();

      await service.upload({
        filename: 'новое-имя.txt',
        buffer: Buffer.from('одно и то же'),
      });

      const where = (
        prisma.mediaAsset.findFirst.mock.calls as unknown[][]
      )[0][0] as { where: Record<string, unknown> };
      expect(where.where).toMatchObject({ filename: 'новое-имя.txt' });
      expect(where.where.checksum).toEqual(expect.any(String));
      expect(prisma.mediaAsset.create).toHaveBeenCalled();
    });
  });

  describe('type detection', () => {
    it('identifies an image by its bytes, ignoring the declared type', async () => {
      const { service, prisma } = setup();

      await service.upload({
        filename: 'photo.txt',
        buffer: await makeImage('png'),
        // Both the name and the declared type are wrong on purpose: the
        // Content-Type of a multipart part is attacker-controlled, and it
        // must not decide whether we re-encode the file.
        declaredMimeType: 'text/plain',
      });

      expect(createdAsset(prisma)).toMatchObject({
        kind: 'image',
        mimeType: 'image/png',
      });
    });

    it('treats anything sharp cannot read as a document', async () => {
      const { service, prisma } = setup();

      await service.upload({
        filename: 'отчёт.pdf',
        buffer: Buffer.from('%PDF-1.4 не настоящий pdf'),
        declaredMimeType: 'application/pdf',
      });

      expect(createdAsset(prisma)).toMatchObject({
        kind: 'document',
        mimeType: 'application/pdf',
        filename: 'отчёт.pdf',
      });
    });

    it('identifies a video by its bytes, ignoring the declared type', async () => {
      // Раньше видео не отличалось от документа и уходило в MAX файлом на
      // скачивание, не проигрывателем, — то, что заметил пользователь.
      const { service, prisma } = setup();

      await service.upload({
        filename: 'ролик.bin',
        buffer: makeVideo(),
        declaredMimeType: 'application/octet-stream',
      });

      expect(createdAsset(prisma)).toMatchObject({
        kind: 'video',
        mimeType: 'video/mp4',
      });
    });

    it('identifies webm specifically, not just mp4 — a different signature entirely', async () => {
      const { service, prisma } = setup();

      await service.upload({
        filename: 'запись.bin',
        buffer: makeWebm(),
        declaredMimeType: 'application/octet-stream',
      });

      expect(createdAsset(prisma)).toMatchObject({
        kind: 'video',
        mimeType: 'video/webm',
      });
    });

    it('treats an unrecognised video-ish container as a document, not a guess', async () => {
      const { service, prisma } = setup();

      // Похоже на видео по имени, но реальный пробник по содержимому
      // ничего не находит — тот же принцип, что и у изображений.
      await service.upload({
        filename: 'ролик.mp4',
        buffer: Buffer.from('не настоящее видео'),
        declaredMimeType: 'video/mp4',
      });

      expect(createdAsset(prisma)).toMatchObject({ kind: 'document' });
    });

    it('falls back to a neutral type when none was declared', async () => {
      const { service, prisma } = setup();

      await service.upload({ filename: 'data.bin', buffer: Buffer.from('xx') });

      expect(createdAsset(prisma)).toMatchObject({
        mimeType: 'application/octet-stream',
      });
    });
  });

  describe('optimization', () => {
    it('shrinks a PNG without changing a single pixel', async () => {
      const { service, prisma, written } = setup();
      const original = await makeImage('png');

      await service.upload({ filename: 'a.png', buffer: original });

      const asset = createdAsset(prisma);
      expect(asset.optimizedPath).not.toBeNull();
      expect(asset.optimizedSizeBytes as number).toBeLessThan(
        original.byteLength,
      );

      // The point of the whole feature: smaller bytes, identical image.
      const optimized = written[1].buffer;
      const pixelsOf = (buffer: Buffer) => sharp(buffer).raw().toBuffer();
      expect(await pixelsOf(optimized)).toEqual(await pixelsOf(original));
    });

    it('leaves a JPEG alone, because re-encoding it is lossy', async () => {
      const { service, prisma, written } = setup();

      await service.upload({
        filename: 'a.jpg',
        buffer: await makeImage('jpeg'),
      });

      // Any JPEG re-encode decodes and recompresses, losing quality — and
      // measured on real data it also produced a *larger* file.
      expect(createdAsset(prisma).optimizedPath).toBeNull();
      expect(written).toHaveLength(1);
    });

    it('leaves a GIF alone, because re-encoding re-quantises its palette', async () => {
      const { service, prisma } = setup();

      await service.upload({
        filename: 'a.gif',
        buffer: await makeImage('gif'),
      });

      expect(createdAsset(prisma).optimizedPath).toBeNull();
    });

    it('never touches a document', async () => {
      const { service, prisma, written } = setup();
      const bytes = Buffer.from('важный документ, байты обязаны совпасть');

      await service.upload({ filename: 'doc.docx', buffer: bytes });

      // A .docx or .pdf must arrive byte-identical; re-encoding corrupts it.
      expect(written).toHaveLength(1);
      expect(written[0].buffer).toEqual(bytes);
      expect(createdAsset(prisma).optimizedPath).toBeNull();
    });
  });

  describe('validation', () => {
    it('rejects an empty file', async () => {
      const { service } = setup();

      await expect(
        service.upload({ filename: 'x', buffer: Buffer.alloc(0) }),
      ).rejects.toBeInstanceOf(AppException);
    });

    it('rejects a file over the limit', async () => {
      const { service } = setup();

      await expect(
        service.upload({
          filename: 'big.bin',
          buffer: Buffer.alloc(51 * 1024 * 1024),
        }),
      ).rejects.toBeInstanceOf(AppException);
    });
  });

  it('removes the written files when the database insert fails', async () => {
    const { service, prisma, storage } = setup();
    prisma.mediaAsset.create.mockRejectedValue(new Error('БД недоступна'));

    await expect(
      service.upload({ filename: 'a.png', buffer: await makeImage('png') }),
    ).rejects.toThrow();

    // No row means no path to find those bytes by, and the upload is reported
    // as failed — leaving them would slowly fill the volume with unreachable
    // files.
    expect(storage.remove).toHaveBeenCalledTimes(2); // original + optimized
  });

  it('publishes the optimized copy when there is one, the original otherwise', async () => {
    const { service, storage } = setup();

    await service.readForUpload({
      storagePath: 'orig',
      optimizedPath: 'opt',
    } as never);
    expect(storage.read).toHaveBeenLastCalledWith('opt');

    await service.readForUpload({
      storagePath: 'orig',
      optimizedPath: null,
    } as never);
    expect(storage.read).toHaveBeenLastCalledWith('orig');
  });

  describe('readPreview', () => {
    it('throws NOT_FOUND when the asset does not exist', async () => {
      const { service, prisma } = setup();
      prisma.mediaAsset.findUnique.mockResolvedValue(null);

      await expect(service.readPreview('missing', 'full')).rejects.toThrow(
        AppException,
      );
    });

    it('throws NOT_FOUND for a document — nothing to render as a picture', async () => {
      const { service, prisma } = setup();
      prisma.mediaAsset.findUnique.mockResolvedValue({
        kind: 'document',
        storagePath: 'p',
        optimizedPath: null,
      });

      await expect(service.readPreview('doc-id', 'thumb')).rejects.toThrow(
        AppException,
      );
    });

    it('size=full returns the published bytes untouched', async () => {
      const { service, prisma, storage } = setup();
      const original = await makeImage('png', 400, 300);
      prisma.mediaAsset.findUnique.mockResolvedValue({
        kind: 'image',
        mimeType: 'image/png',
        storagePath: 'p',
        optimizedPath: null,
      });
      storage.read.mockResolvedValue(original);

      const { buffer, mimeType } = await service.readPreview('id', 'full');

      expect(buffer).toBe(original);
      expect(mimeType).toBe('image/png');
    });

    it('size=thumb shrinks a large image to fit the thumbnail box', async () => {
      const { service, prisma, storage } = setup();
      prisma.mediaAsset.findUnique.mockResolvedValue({
        kind: 'image',
        mimeType: 'image/png',
        storagePath: 'p',
        optimizedPath: null,
      });
      storage.read.mockResolvedValue(await makeImage('png', 400, 300));

      const { buffer } = await service.readPreview('id', 'thumb');
      const metadata = await sharp(buffer).metadata();

      expect(metadata.width).toBeLessThanOrEqual(200);
      expect(metadata.height).toBeLessThanOrEqual(200);
    });

    it('size=thumb does not enlarge an image already smaller than the box', async () => {
      const { service, prisma, storage } = setup();
      prisma.mediaAsset.findUnique.mockResolvedValue({
        kind: 'image',
        mimeType: 'image/png',
        storagePath: 'p',
        optimizedPath: null,
      });
      storage.read.mockResolvedValue(await makeImage('png', 120, 90));

      const { buffer } = await service.readPreview('id', 'thumb');
      const metadata = await sharp(buffer).metadata();

      expect(metadata.width).toBe(120);
      expect(metadata.height).toBe(90);
    });
  });
});
