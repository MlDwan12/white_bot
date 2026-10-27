import { VkApiClient, uploadFileName } from './vk-api.client';
import { VK_UPLOAD_REJECTED, VkApiError } from './vk-api.error';

function mockFetchOnce(response: Partial<Response>) {
  global.fetch = jest.fn().mockResolvedValue(response) as typeof fetch;
}

function mockFetchSequence(...responses: Partial<Response>[]) {
  const fn = jest.fn();
  for (const response of responses) {
    fn.mockResolvedValueOnce(response);
  }
  global.fetch = fn as typeof fetch;
}

function jsonResponse(body: unknown): Partial<Response> {
  return { ok: true, status: 200, json: () => Promise.resolve(body) };
}

function testAttachment(kind: 'photo' | 'doc') {
  return {
    kind,
    filename: kind === 'photo' ? 'photo.jpg' : 'doc.txt',
    mimeType: kind === 'photo' ? 'image/jpeg' : 'text/plain',
    buffer: Buffer.from('fake-file-bytes'),
  } as const;
}

describe('VkApiClient', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('throws a clean VkApiError instead of a raw SyntaxError on a non-JSON error page', async () => {
    mockFetchOnce({
      ok: false,
      status: 502,
      json: () => Promise.reject(new SyntaxError('Unexpected token <')),
    });
    const client = new VkApiClient();

    await expect(client.resolveGroupInfo('token')).rejects.toThrow(VkApiError);
  });

  it('throws a clean VkApiError when a 200 response body is not valid JSON', async () => {
    mockFetchOnce({
      ok: true,
      status: 200,
      json: () => Promise.reject(new SyntaxError('Unexpected end of JSON')),
    });
    const client = new VkApiClient();

    await expect(client.resolveGroupInfo('token')).rejects.toThrow(VkApiError);
  });

  it('surfaces VK API-level errors from a 200 response', async () => {
    mockFetchOnce({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          error: { error_code: 5, error_msg: 'User authorization failed' },
        }),
    });
    const client = new VkApiClient();

    await expect(client.resolveGroupInfo('token')).rejects.toMatchObject({
      code: 5,
    });
  });

  describe('wallPost / wallEdit / wallDelete', () => {
    it('posts with a negative owner_id and comma-joined attachment refs', async () => {
      mockFetchOnce(jsonResponse({ response: { post_id: 777 } }));
      const client = new VkApiClient();

      const result = await client.wallPost('token', '123', 'hello', [
        'photo-123_1',
        'doc-123_2',
      ]);

      expect(result).toEqual({ postId: 777 });
      const [, init] = (global.fetch as jest.Mock).mock.calls[0] as [
        string,
        { body: URLSearchParams },
      ];
      expect(init.body.get('owner_id')).toBe('-123');
      expect(init.body.get('attachments')).toBe('photo-123_1,doc-123_2');
    });

    it('edits with an explicit empty attachments param when none are given', async () => {
      // В отличие от wallPost (новый пост — нечего сохранять), правка обязана
      // прислать параметр всегда: отсутствие поля у VK, по всей видимости,
      // означает «не трогать вложения», а не «убрать их» — тот же живой факт,
      // что и у MAX (см. комментарий у wallEdit). Не проверено на самом VK:
      // wall.edit пока отклоняется для любого значения параметра.
      mockFetchOnce(jsonResponse({ response: 1 }));
      const client = new VkApiClient();

      await client.wallEdit('token', '123', 777, 'updated text');

      const [, init] = (global.fetch as jest.Mock).mock.calls[0] as [
        string,
        { body: URLSearchParams },
      ];
      expect(init.body.get('attachments')).toBe('');
      expect(init.body.get('post_id')).toBe('777');
    });

    it('edits with the given attachments joined by comma', async () => {
      mockFetchOnce(jsonResponse({ response: 1 }));
      const client = new VkApiClient();

      await client.wallEdit('token', '123', 777, 'updated text', [
        'photo-123_1',
        'doc-123_2',
      ]);

      const [, init] = (global.fetch as jest.Mock).mock.calls[0] as [
        string,
        { body: URLSearchParams },
      ];
      expect(init.body.get('attachments')).toBe('photo-123_1,doc-123_2');
    });

    it('deletes by post_id with a negative owner_id', async () => {
      mockFetchOnce(jsonResponse({ response: 1 }));
      const client = new VkApiClient();

      await client.wallDelete('token', '123', 777);

      const [, init] = (global.fetch as jest.Mock).mock.calls[0] as [
        string,
        { body: URLSearchParams },
      ];
      expect(init.body.get('owner_id')).toBe('-123');
      expect(init.body.get('post_id')).toBe('777');
    });
  });

  describe('uploadAttachment', () => {
    it('uploads a photo through the getWallUploadServer -> upload -> saveWallPhoto flow', async () => {
      mockFetchSequence(
        jsonResponse({ response: { upload_url: 'https://upload.vk/photo' } }),
        jsonResponse({ server: 1, photo: 'raw-photo-payload', hash: 'h' }),
        jsonResponse({ response: [{ id: 456, owner_id: -123 }] }),
      );
      const client = new VkApiClient();

      const ref = await client.uploadAttachment(
        'token',
        '123',
        testAttachment('photo'),
      );

      expect(ref).toBe('photo-123_456');
      expect(global.fetch).toHaveBeenCalledTimes(3);
    });

    it('uploads a video through video.save -> upload, as a playable video attachment', async () => {
      mockFetchSequence(
        jsonResponse({
          response: {
            upload_url: 'https://upload.vk/video',
            video_id: 55,
            owner_id: -123,
          },
        }),
        jsonResponse({ size: 10, video_id: 55, video_hash: 'x' }),
      );
      const client = new VkApiClient();

      const ref = await client.uploadAttachment('token', '123', {
        ...testAttachment('doc'),
        kind: 'video',
        filename: 'Запись экрана.webm',
      });

      expect(ref).toBe('video-123_55');
      const [url, init] = (global.fetch as jest.Mock).mock.calls[0] as [
        string,
        { body: URLSearchParams },
      ];
      expect(url).toContain('video.save');
      // Название видеозаписи видят зрители — без расширения; отдельного поста
      // о новом видео не публикуем.
      expect(init.body.get('name')).toBe('Запись экрана');
      expect(init.body.get('wallpost')).toBe('0');
    });

    it('blames the uploader token, not the community, when it lacks the video right', async () => {
      mockFetchSequence(
        jsonResponse({
          error: { error_code: 15, error_msg: 'Access denied' },
        }),
      );
      const client = new VkApiClient();

      await expect(
        client.uploadAttachment('token', '123', {
          ...testAttachment('doc'),
          kind: 'video',
        }),
      ).rejects.toMatchObject({
        code: VK_UPLOAD_REJECTED,
        message: expect.stringContaining('переподключите') as string,
      });
    });

    it('surfaces a rejected video upload instead of attaching a dead reference', async () => {
      mockFetchSequence(
        jsonResponse({
          response: {
            upload_url: 'https://upload.vk/video',
            video_id: 55,
            owner_id: -123,
          },
        }),
        jsonResponse({}),
      );
      const client = new VkApiClient();

      await expect(
        client.uploadAttachment('token', '123', {
          ...testAttachment('doc'),
          kind: 'video',
        }),
      ).rejects.toMatchObject({ code: VK_UPLOAD_REJECTED });
    });

    it('uploads a document through the getWallUploadServer -> upload -> docs.save flow', async () => {
      mockFetchSequence(
        jsonResponse({ response: { upload_url: 'https://upload.vk/doc' } }),
        jsonResponse({ file: 'raw-doc-payload' }),
        jsonResponse({ response: { doc: { id: 789, owner_id: -123 } } }),
      );
      const client = new VkApiClient();

      const ref = await client.uploadAttachment(
        'token',
        '123',
        testAttachment('doc'),
      );

      expect(ref).toBe('doc-123_789');
    });

    it('throws a clean VkApiError when the raw upload endpoint itself fails', async () => {
      mockFetchSequence(
        jsonResponse({ response: { upload_url: 'https://upload.vk/photo' } }),
        { ok: false, status: 500, json: () => Promise.resolve({}) },
      );
      const client = new VkApiClient();

      await expect(
        client.uploadAttachment('token', '123', testAttachment('photo')),
      ).rejects.toThrow(VkApiError);
    });

    it("surfaces the upload server's own error instead of calling saveWallPhoto with nothing", async () => {
      mockFetchSequence(
        jsonResponse({ response: { upload_url: 'https://upload.vk/photo' } }),
        jsonResponse({
          error: 'ERR_UPLOAD_BAD_IMAGE_SIZE',
          error_descr: 'image is too small',
        }),
      );
      const client = new VkApiClient();

      await expect(
        client.uploadAttachment('token', '123', testAttachment('photo')),
      ).rejects.toMatchObject({
        code: VK_UPLOAD_REJECTED,
        message:
          'VK отклонил загрузку файла: ERR_UPLOAD_BAD_IMAGE_SIZE: image is too small',
      });
      // saveWallPhoto так и не вызван — иначе VK ответил бы «photo is undefined».
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    it('rejects an upload that came back with an empty photo list', async () => {
      mockFetchSequence(
        jsonResponse({ response: { upload_url: 'https://upload.vk/photo' } }),
        jsonResponse({ server: 1, photo: '[]', hash: 'h' }),
      );
      const client = new VkApiClient();

      await expect(
        client.uploadAttachment('token', '123', testAttachment('photo')),
      ).rejects.toMatchObject({ code: VK_UPLOAD_REJECTED });
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    it('rejects a document upload that came back without a file, before docs.save', async () => {
      mockFetchSequence(
        jsonResponse({ response: { upload_url: 'https://upload.vk/doc' } }),
        jsonResponse({}),
      );
      const client = new VkApiClient();

      await expect(
        client.uploadAttachment('token', '123', testAttachment('doc')),
      ).rejects.toMatchObject({ code: VK_UPLOAD_REJECTED });
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    it('throws when VK reports no saved photo', async () => {
      mockFetchSequence(
        jsonResponse({ response: { upload_url: 'https://upload.vk/photo' } }),
        jsonResponse({ server: 1, photo: 'raw-photo-payload', hash: 'h' }),
        jsonResponse({ response: [] }),
      );
      const client = new VkApiClient();

      await expect(
        client.uploadAttachment('token', '123', testAttachment('photo')),
      ).rejects.toThrow(VkApiError);
    });

    it('throws a clean VkApiError when docs.save reports no saved document', async () => {
      mockFetchSequence(
        jsonResponse({ response: { upload_url: 'https://upload.vk/doc' } }),
        jsonResponse({ file: 'raw-doc-payload' }),
        jsonResponse({ response: {} }),
      );
      const client = new VkApiClient();

      await expect(
        client.uploadAttachment('token', '123', testAttachment('doc')),
      ).rejects.toThrow(VkApiError);
    });
  });

  it('sends VK an ASCII-only file name, since its upload server drops Cyrillic ones silently', async () => {
    mockFetchSequence(
      jsonResponse({ response: { upload_url: 'https://upload.vk/photo' } }),
      jsonResponse({ server: 1, photo: 'raw', hash: 'h' }),
      jsonResponse({ response: [{ id: 1, owner_id: -123 }] }),
    );
    const client = new VkApiClient();

    await client.uploadAttachment('token', '123', {
      ...testAttachment('photo'),
      filename: 'Снимок экрана от 2026-09-23 09-16-38.PNG',
    });

    const [, init] = (global.fetch as jest.Mock).mock.calls[1] as [
      string,
      { body: FormData },
    ];
    const body = init.body;
    expect((body.get('photo') as File).name).toBe('file.png');
  });
});

describe('uploadFileName', () => {
  it.each([
    ['Снимок экрана.png', 'file.png'],
    ['отчёт.PDF', 'file.pdf'],
    ['без расширения', 'file'],
    ['archive.tar.gz', 'file.gz'],
  ])('%s → %s', (original, expected) => {
    expect(uploadFileName(original)).toBe(expected);
  });
});
