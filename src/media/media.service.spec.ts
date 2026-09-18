import sharp from 'sharp';
import { PinoLogger } from 'nestjs-pino';
import { AppException } from '../common/app-exception';
import { PrismaService } from '../prisma/prisma.service';
import { MediaService } from './media.service';
import { MediaStorageService } from './media-storage.service';

/** A noisy image, so compression gains aren't an artefact of flat colour. */
async function makeImage(format: 'png' | 'jpeg' | 'gif'): Promise<Buffer> {
  const width = 120;
  const height = 90;
  const raw = Buffer.alloc(width * height * 3);
  for (let i = 0; i < raw.length; i++) {
    raw[i] = (Math.sin(i * 0.37) * 127 + 128) | 0;
  }
  const image = sharp(raw, { raw: { width, height, channels: 3 } });
  if (format === 'png') return image.png({ compressionLevel: 6 }).toBuffer();
  if (format === 'jpeg') return image.jpeg({ quality: 90 }).toBuffer();
  return image.gif().toBuffer();
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
function createdAsset(prisma: { mediaAsset: { create: jest.Mock } }) {
  const calls = prisma.mediaAsset.create.mock.calls as unknown[][];
  return (calls[0][0] as { data: Record<string, unknown> }).data;
}

describe('MediaService', () => {
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
});
