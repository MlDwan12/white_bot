import { PrismaService } from '../prisma/prisma.service';
import { Group, MediaAsset } from '../generated/prisma/client';
import { MediaService } from '../media/media.service';
import { VkApiClient } from '../vk/vk-api.client';
import { MaxApiClient } from '../max/max-api.client';
import { VkUploaderTokenService } from '../vk/vk-uploader-token.service';
import { PinoLogger } from 'nestjs-pino';
import { Prisma } from '../generated/prisma/client';
import { AttachmentUploader } from './attachment-uploader';

/** A cache row as the database returns it. */
function cachedRow(externalRef: string, ageMs = 0) {
  return { externalRef, createdAt: new Date(Date.now() - ageMs) };
}

function asset(overrides: Partial<MediaAsset> = {}): MediaAsset {
  return {
    id: 'asset-1',
    filename: 'photo.png',
    kind: 'image',
    mimeType: 'image/png',
    storagePath: 'p1',
    optimizedPath: null,
    ...overrides,
  } as MediaAsset;
}

const vkGroup = { id: 'g1', platform: 'vk', externalId: '123' } as Group;

function setup() {
  const prisma = {
    mediaPlatformUpload: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn(({ data }: { data: object }) => Promise.resolve(data)),
      update: jest.fn().mockResolvedValue({}),
    },
  };
  const media = {
    readForUpload: jest.fn().mockResolvedValue(Buffer.from('bytes')),
    // Mirrors the real helper: hands over a path whose basename is the
    // asset's original file name, then cleans up.
    withUploadPath: jest.fn(
      (asset: { filename: string }, use: (p: string) => Promise<unknown>) =>
        use(`/tmp/upload-xyz/${asset.filename}`),
    ),
  };
  const vk = { uploadAttachment: jest.fn().mockResolvedValue('photo-1_2') };
  const max = {
    uploadAttachment: jest
      .fn()
      .mockResolvedValue({ type: 'image', payload: { token: 'tok' } }),
  };
  const vkUploaderToken = {
    getValidAccessToken: jest.fn().mockResolvedValue('personal-token'),
  };

  const logger = { setContext: jest.fn(), warn: jest.fn() };

  const uploader = new AttachmentUploader(
    prisma as unknown as PrismaService,
    media as unknown as MediaService,
    vk as unknown as VkApiClient,
    max as unknown as MaxApiClient,
    vkUploaderToken as unknown as VkUploaderTokenService,
    logger as unknown as PinoLogger,
  );
  return { uploader, prisma, media, vk, max, vkUploaderToken, logger };
}

describe('AttachmentUploader', () => {
  describe('VK', () => {
    it('uploads with the personal token and returns the wall reference', async () => {
      const { uploader, vk, vkUploaderToken } = setup();

      const refs = await uploader.vkRefs([asset()], vkGroup);

      // A community token cannot upload attachments at all (VK error 27).
      expect(vkUploaderToken.getValidAccessToken).toHaveBeenCalled();
      expect(vk.uploadAttachment).toHaveBeenCalledWith(
        'personal-token',
        '123',
        expect.objectContaining({ kind: 'photo', filename: 'photo.png' }),
      );
      expect(refs).toEqual(['photo-1_2']);
    });

    it('sends a document through the document path, not the photo one', async () => {
      const { uploader, vk } = setup();

      await uploader.vkRefs([asset({ kind: 'document' })], vkGroup);

      expect(vk.uploadAttachment).toHaveBeenCalledWith(
        'personal-token',
        '123',
        expect.objectContaining({ kind: 'doc' }),
      );
    });

    it('reuses a cached reference instead of uploading again', async () => {
      const { uploader, prisma, vk } = setup();
      prisma.mediaPlatformUpload.findUnique.mockResolvedValue(
        cachedRow('photo-9_9'),
      );

      const refs = await uploader.vkRefs([asset()], vkGroup);

      // Without the cache, a retry after a rate limit would re-upload the
      // file — spending the very budget that caused the retry.
      expect(vk.uploadAttachment).not.toHaveBeenCalled();
      expect(refs).toEqual(['photo-9_9']);
    });

    it('caches per group, since a VK reference belongs to one community', async () => {
      const { uploader, prisma } = setup();

      await uploader.vkRefs([asset()], vkGroup);

      const data = (
        prisma.mediaPlatformUpload.create.mock.calls[0] as unknown[]
      )[0] as { data: { scope: string; platform: string } };
      expect(data.data).toMatchObject({ scope: 'g1', platform: 'vk' });
    });

    it('keeps attachment order, which is part of the post', async () => {
      const { uploader, vk } = setup();
      vk.uploadAttachment
        .mockResolvedValueOnce('photo-1_1')
        .mockResolvedValueOnce('doc-2_2');

      const refs = await uploader.vkRefs(
        [asset({ id: 'a1' }), asset({ id: 'a2', kind: 'document' })],
        vkGroup,
      );

      expect(refs).toEqual(['photo-1_1', 'doc-2_2']);
    });

    it('keeps using an old VK reference, which never expires', async () => {
      const { uploader, prisma, vk } = setup();
      const aYear = 365 * 24 * 60 * 60 * 1000;
      prisma.mediaPlatformUpload.findUnique.mockResolvedValue(
        cachedRow('photo-9_9', aYear),
      );

      await uploader.vkRefs([asset()], vkGroup);

      expect(vk.uploadAttachment).not.toHaveBeenCalled();
    });

    it('fetches the token only when something actually needs uploading', async () => {
      const { uploader, prisma, vkUploaderToken } = setup();
      prisma.mediaPlatformUpload.findUnique.mockResolvedValue(
        cachedRow('photo-9_9'),
      );

      await uploader.vkRefs([asset()], vkGroup);

      // Everything was cached, so an expired personal token must not block a
      // resume that has nothing left to upload.
      expect(vkUploaderToken.getValidAccessToken).not.toHaveBeenCalled();
    });

    it('does not lose the delivery when the cache write fails for another reason', async () => {
      const { uploader, prisma, logger } = setup();
      prisma.mediaPlatformUpload.create.mockRejectedValue(
        new Error('пул исчерпан'),
      );

      // A cold cache costs an extra upload next time; failing the delivery
      // would cost the campaign.
      await expect(uploader.vkRefs([asset()], vkGroup)).resolves.toEqual([
        'photo-1_2',
      ]);
      expect(logger.warn).toHaveBeenCalled();
    });

    it('does not ask for a token when there is nothing to upload', async () => {
      const { uploader, vkUploaderToken } = setup();

      await expect(uploader.vkRefs([], vkGroup)).resolves.toEqual([]);
      expect(vkUploaderToken.getValidAccessToken).not.toHaveBeenCalled();
    });

    it('survives losing the create race by reading the winner row', async () => {
      const { uploader, prisma } = setup();
      prisma.mediaPlatformUpload.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: 'test',
        }),
      );
      prisma.mediaPlatformUpload.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(cachedRow('photo-7_7'));

      await expect(uploader.vkRefs([asset()], vkGroup)).resolves.toEqual([
        'photo-7_7',
      ]);
    });
  });

  describe('MAX', () => {
    it('caches once for the whole bot, not per chat', async () => {
      const { uploader, prisma } = setup();

      await uploader.maxAttachments([asset()]);

      // A MAX attachment token is issued to the bot and works in every chat,
      // so one upload serves them all.
      const data = (
        prisma.mediaPlatformUpload.create.mock.calls[0] as unknown[]
      )[0] as { data: { scope: string; platform: string } };
      expect(data.data).toMatchObject({ platform: 'max' });
      expect(data.data.scope).not.toBe('g1');
    });

    it('returns the attachment object a send call can use', async () => {
      const { uploader } = setup();

      await expect(uploader.maxAttachments([asset()])).resolves.toEqual([
        { type: 'image', payload: { token: 'tok' } },
      ]);
    });

    it('passes a path, not bytes, so a document keeps its name', async () => {
      const { uploader, max, media } = setup();

      await uploader.maxAttachments([
        asset({ kind: 'document', filename: 'Прайс-лист.pdf' }),
      ]);

      // The SDK takes the displayed name from its source: a Buffer shows a
      // random uuid, and the raw storage path shows our generated one. Only a
      // path carrying the original name gives the recipient the right file.
      expect(media.withUploadPath).toHaveBeenCalled();
      expect(max.uploadAttachment).toHaveBeenCalledWith({
        kind: 'file',
        source: '/tmp/upload-xyz/Прайс-лист.pdf',
      });
    });

    it('шлёт видео через uploadVideo, а не файлом', async () => {
      // Без этого видео уходило бы в MAX документом на скачивание, а не
      // проигрывателем — ровно то, что заметил и указал пользователь.
      const { uploader, max } = setup();

      await uploader.maxAttachments([
        asset({ kind: 'video', filename: 'ролик.webm' }),
      ]);

      expect(max.uploadAttachment).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'video' }),
      );
    });

    it('re-uploads once a cached MAX reference has aged out', async () => {
      const { uploader, prisma, max } = setup();
      const twoWeeks = 14 * 24 * 60 * 60 * 1000;
      prisma.mediaPlatformUpload.findUnique.mockResolvedValue(
        cachedRow('{"type":"image"}', twoWeeks),
      );

      await uploader.maxAttachments([asset()]);

      // MAX documents no token lifetime and the scope isn't tied to a bot
      // identity, so a rotated token would otherwise replay a dead reference
      // forever.
      expect(max.uploadAttachment).toHaveBeenCalled();
      expect(prisma.mediaPlatformUpload.update).toHaveBeenCalled();
    });

    it('restores a cached attachment from its stored form', async () => {
      const { uploader, prisma, max } = setup();
      prisma.mediaPlatformUpload.findUnique.mockResolvedValue(
        cachedRow(JSON.stringify({ type: 'file', payload: { token: 't2' } })),
      );

      const attachments = await uploader.maxAttachments([asset()]);

      expect(max.uploadAttachment).not.toHaveBeenCalled();
      expect(attachments).toEqual([{ type: 'file', payload: { token: 't2' } }]);
    });
  });
});
