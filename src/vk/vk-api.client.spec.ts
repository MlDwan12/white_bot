import { VkApiClient } from './vk-api.client';
import { VkApiError } from './vk-api.error';

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
});
