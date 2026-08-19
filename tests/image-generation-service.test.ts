import { afterEach, describe, expect, test, vi } from 'vitest';

const getImageGenerationBackendConfig = vi.fn();
vi.mock('../src/runtime-config.js', () => ({
  getImageGenerationBackendConfig,
}));

const { generateWorkspaceImage, ImageGenerationError } =
  await import('../src/image-generation-service.js');

afterEach(() => {
  vi.restoreAllMocks();
  getImageGenerationBackendConfig.mockReset();
});

const TINY_PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00,
]);

function mockBackend() {
  getImageGenerationBackendConfig.mockReturnValue({
    baseUrl: 'https://images.example.test/v1/',
    apiKey: 'test-key',
    updatedAt: '',
  });
}

function mockSuccessResponse() {
  return new Response(
    JSON.stringify({ data: [{ b64_json: TINY_PNG.toString('base64') }] }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

describe('generateWorkspaceImage', () => {
  test('calls the managed Images API and returns a validated base64 PNG', async () => {
    mockBackend();
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(mockSuccessResponse());

    await expect(
      generateWorkspaceImage('a hedgehog in the desert', 'gpt-image-2'),
    ).resolves.toEqual({
      data: TINY_PNG.toString('base64'),
      mimeType: 'image/png',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://images.example.test/v1/images/generations',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer test-key' }),
        body: JSON.stringify({
          model: 'gpt-image-2',
          prompt: 'a hedgehog in the desert',
          size: '1024x1024',
        }),
      }),
    );
  });

  test('routes reference images to the edits endpoint as multipart image[] fields', async () => {
    mockBackend();
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(mockSuccessResponse());

    await generateWorkspaceImage('blend the scenes', 'gpt-image-2', [
      { data: TINY_PNG, mimeType: 'image/png' },
      {
        data: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]),
        mimeType: 'image/jpeg',
      },
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe('https://images.example.test/v1/images/edits');
    expect(init.method).toBe('POST');
    const form = init.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get('model')).toBe('gpt-image-2');
    expect(form.get('prompt')).toBe('blend the scenes');
    const images = form.getAll('image[]');
    expect(images).toHaveLength(2);
    expect((images[0] as File).name).toBe('reference-1.png');
    expect((images[1] as File).name).toBe('reference-2.jpg');
  });

  test('rejects more than six reference images before any network call', async () => {
    mockBackend();
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    await expect(
      generateWorkspaceImage('too many', 'gpt-image-2', [
        ...Array.from({ length: 7 }, () => ({
          data: TINY_PNG,
          mimeType: 'image/png' as const,
        })),
      ]),
    ).rejects.toMatchObject<ImageGenerationError>({ status: 400 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('rejects a reference image whose bytes do not match a supported format', async () => {
    mockBackend();
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    await expect(
      generateWorkspaceImage('bad ref', 'gpt-image-2', [
        {
          data: Buffer.from('not an image at all'),
          mimeType: 'image/png',
        },
      ]),
    ).rejects.toMatchObject<ImageGenerationError>({ status: 400 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('does not call a backend when none is configured', async () => {
    getImageGenerationBackendConfig.mockReturnValue(null);

    await expect(
      generateWorkspaceImage('a hedgehog in the desert', 'gpt-image-2'),
    ).rejects.toMatchObject<ImageGenerationError>({ status: 409 });
  });

  test('rejects an invalid image payload instead of persisting it', async () => {
    mockBackend();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [{ b64_json: Buffer.from('not an image').toString('base64') }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    await expect(
      generateWorkspaceImage('a hedgehog in the desert', 'gpt-image-2'),
    ).rejects.toMatchObject<ImageGenerationError>({ status: 502 });
  });
});
