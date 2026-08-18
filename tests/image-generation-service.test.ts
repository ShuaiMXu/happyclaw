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

describe('generateWorkspaceImage', () => {
  test('calls the managed Images API and returns a validated base64 PNG', async () => {
    getImageGenerationBackendConfig.mockReturnValue({
      baseUrl: 'https://images.example.test/v1/',
      apiKey: 'test-key',
      updatedAt: '',
    });
    const png = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00,
    ]);
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(
          JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );

    await expect(
      generateWorkspaceImage('a hedgehog in the desert', 'gpt-image-2'),
    ).resolves.toEqual({ data: png.toString('base64'), mimeType: 'image/png' });
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

  test('does not call a backend when none is configured', async () => {
    getImageGenerationBackendConfig.mockReturnValue(null);

    await expect(
      generateWorkspaceImage('a hedgehog in the desert', 'gpt-image-2'),
    ).rejects.toMatchObject<ImageGenerationError>({ status: 409 });
  });

  test('rejects an invalid image payload instead of persisting it', async () => {
    getImageGenerationBackendConfig.mockReturnValue({
      baseUrl: 'https://images.example.test/v1',
      apiKey: 'test-key',
      updatedAt: '',
    });
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
