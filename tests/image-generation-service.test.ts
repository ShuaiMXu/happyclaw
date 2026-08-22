import { afterEach, describe, expect, test, vi } from 'vitest';

const getImageGenerationBackendConfig = vi.fn();
vi.mock('../src/runtime-config.js', () => ({
  getImageGenerationBackendConfig,
}));

const {
  generateWorkspaceImage,
  ImageGenerationError,
  resolveImageSize,
  describeImageRequirements,
  describeCurrentDateTime,
} = await import('../src/image-generation-service.js');

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
    expect(form.get('size')).toBe('1024x1024');
    const images = form.getAll('image[]');
    expect(images).toHaveLength(2);
    expect((images[0] as File).name).toBe('reference-1.png');
    expect((images[1] as File).name).toBe('reference-2.jpg');
  });

  test('threads a custom size through to the text-to-image request body', async () => {
    mockBackend();
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(mockSuccessResponse());

    await generateWorkspaceImage(
      'a hedgehog in the desert',
      'gpt-image-2',
      [],
      '3840x2160',
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'https://images.example.test/v1/images/generations',
      expect.objectContaining({
        body: JSON.stringify({
          model: 'gpt-image-2',
          prompt: 'a hedgehog in the desert',
          size: '3840x2160',
        }),
      }),
    );
  });

  test('threads a custom size through to the edits request form', async () => {
    mockBackend();
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(mockSuccessResponse());

    await generateWorkspaceImage(
      'blend the scenes',
      'gpt-image-2',
      [{ data: TINY_PNG, mimeType: 'image/png' }],
      '1080x1920',
    );

    const [, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    const form = init.body as FormData;
    expect(form.get('size')).toBe('1080x1920');
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

  test('surfaces a moderation block as a 400 with an actionable message', async () => {
    mockBackend();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            message: 'Your request was rejected by the safety system.',
            type: 'image_generation_user_error',
            code: 'moderation_blocked',
          },
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    await expect(
      generateWorkspaceImage('a hedgehog in the desert', 'gpt-image-2'),
    ).rejects.toMatchObject<ImageGenerationError>({
      status: 400,
      message: expect.stringContaining('内容安全审核'),
    });
  });

  test('falls back to a generic 502 for an unrecognized upstream failure', async () => {
    mockBackend();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('upstream exploded', { status: 500 }),
    );

    await expect(
      generateWorkspaceImage('a hedgehog in the desert', 'gpt-image-2'),
    ).rejects.toMatchObject<ImageGenerationError>({ status: 502 });
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

describe('resolveImageSize', () => {
  test('keeps the 2k pixel budget at exactly a quarter of 4k for every aspect ratio', () => {
    const parsePx = (size: string) => {
      const [w, h] = size.split('x').map(Number);
      return w * h;
    };
    for (const aspect of [
      '1:1',
      '4:3',
      '3:2',
      '16:9',
      '21:9',
      '3:4',
      '2:3',
      '9:16',
    ] as const) {
      const px4k = parsePx(resolveImageSize('4k', aspect));
      const px2k = parsePx(resolveImageSize('2k', aspect));
      expect(px2k).toBeCloseTo(px4k / 4, -3);
    }
  });

  test('produces the conventional 3840x2160 / 1920x1080 sizes for 16:9', () => {
    expect(resolveImageSize('4k', '16:9')).toBe('3840x2160');
    expect(resolveImageSize('2k', '16:9')).toBe('1920x1080');
  });

  test('matches width/height to the requested aspect ratio', () => {
    expect(resolveImageSize('4k', '3:2')).toBe('3528x2352');
    expect(resolveImageSize('4k', '2:3')).toBe('2352x3528');
    expect(resolveImageSize('4k', '1:1')).toBe('2880x2880');
    expect(resolveImageSize('4k', '4:3')).toBe('3328x2496');
    expect(resolveImageSize('4k', '3:4')).toBe('2496x3328');
    expect(resolveImageSize('4k', '21:9')).toBe('4396x1884');
  });

  test('"original" fits the reference image\'s exact ratio into the same pixel budget', () => {
    const parse = (size: string) =>
      size.split('x').map(Number) as [number, number];
    const [w, h] = parse(
      resolveImageSize('4k', 'original', { width: 1000, height: 1000 }),
    );
    expect(w).toBe(h); // square reference -> square output
    expect(w * h).toBeCloseTo(3840 * 2160, -3);

    const [w2, h2] = parse(
      resolveImageSize('4k', 'original', { width: 4500, height: 1000 }),
    );
    expect(w2 / h2).toBeCloseTo(4500 / 1000, 1);
    // 16px rounding has a bigger relative effect on area at extreme ratios
    // like this 4.5:1 one, so assert a relative tolerance instead of an
    // absolute one.
    expect(Math.abs(w2 * h2 - 3840 * 2160) / (3840 * 2160)).toBeLessThan(0.01);

    // 2k stays a quarter of 4k for "original" too, same as every preset.
    const px4k = (() => {
      const [w, h] = parse(
        resolveImageSize('4k', 'original', { width: 3, height: 2 }),
      );
      return w * h;
    })();
    const px2k = (() => {
      const [w, h] = parse(
        resolveImageSize('2k', 'original', { width: 3, height: 2 }),
      );
      return w * h;
    })();
    expect(Math.abs(px2k - px4k / 4) / (px4k / 4)).toBeLessThan(0.01);
  });

  test('"original" without a reference falls back to the 4:3 preset', () => {
    expect(resolveImageSize('4k', 'original')).toBe(
      resolveImageSize('4k', '4:3'),
    );
  });
});

describe('describeImageRequirements', () => {
  test('spells out quality and aspect ratio (with orientation) in natural language', () => {
    expect(describeImageRequirements('4k', '16:9')).toBe(
      '请生成画质为 4K 高清、画面比例为 16:9（横版）的图片。',
    );
    expect(describeImageRequirements('2k', '9:16')).toBe(
      '请生成画质为 2K、画面比例为 9:16（竖版）的图片。',
    );
    expect(describeImageRequirements('4k', '1:1')).toBe(
      '请生成画质为 4K 高清、画面比例为 1:1（正方形）的图片。',
    );
  });

  test('"original" describes matching the first reference instead of a fixed ratio', () => {
    expect(describeImageRequirements('4k', 'original')).toContain(
      '与第一张参考图完全一致',
    );
  });
});

describe('describeCurrentDateTime', () => {
  test('grounds the real date/time so the model does not fabricate one', () => {
    // Image models have no clock of their own — a prompt asking to stamp
    // "当前时间" onto a poster otherwise gets whatever date the model
    // fabricates (commonly landing in its own training era, e.g. 2025).
    const fixed = new Date(2026, 7, 22, 17, 14); // 2026-08-22 17:14, a Saturday
    expect(describeCurrentDateTime(fixed)).toBe(
      '如果图片中需要显示当前日期、时间或时间戳，请使用：2026年08月22日（星期六）17:14，不要凭空编造其他年份或日期。',
    );
  });

  test('defaults to the real current time when no date is passed', () => {
    const before = Date.now();
    const text = describeCurrentDateTime();
    const after = Date.now();
    const match = text.match(/(\d{4})年(\d{2})月(\d{2})日/);
    expect(match).not.toBeNull();
    const [, y, m, d] = match!;
    const parsed = new Date(Number(y), Number(m) - 1, Number(d)).getTime();
    // Loose bound: the parsed date should fall within the same UTC day as
    // "now" — exact-to-the-minute comparison would be flaky near midnight.
    expect(Math.abs(parsed - before)).toBeLessThan(
      Math.max(after - before, 0) + 24 * 60 * 60 * 1000,
    );
  });
});
