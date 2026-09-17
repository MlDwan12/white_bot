import { VkApiClient } from './vk-api.client';
import { VkApiError } from './vk-api.error';

function mockFetchOnce(response: Partial<Response>) {
  global.fetch = jest.fn().mockResolvedValue(response) as typeof fetch;
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
});
