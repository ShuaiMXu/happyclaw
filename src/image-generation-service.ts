import { getImageGenerationBackendConfig } from './runtime-config.js';
import { logger } from './logger.js';

const REQUEST_TIMEOUT_MS = 120_000;
const MAX_GENERATED_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_REFERENCE_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_REFERENCE_IMAGES = 6;

export type GeneratedImage = {
  data: string;
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
};

export type ImageReference = {
  /** Raw image bytes of one reference image. */
  data: Uint8Array;
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
};

/** Resolution tier: "4k" targets ~8.3MP (4K UHD budget), "2k" is exactly a
 * quarter of that (half the linear resolution in each dimension), matching
 * the conventional 3840x2160 / 1920x1080 relationship. Both are still
 * accepted here (and by the studio composer's recipe-reuse path, for old
 * generations) but '4k' is no longer offered as a fresh choice — the
 * upstream image backend ignores the `size` request and caps real output
 * well below either nominal tier regardless, so requesting '4k' buys
 * nothing over '2k' in practice. */
export const IMAGE_QUALITIES = ['2k', '4k'] as const;
export type ImageQuality = (typeof IMAGE_QUALITIES)[number];
export const DEFAULT_IMAGE_QUALITY: ImageQuality = '2k';

export const IMAGE_ASPECT_RATIO_PRESETS = [
  '21:9',
  '16:9',
  '3:2',
  '4:3',
  '1:1',
  '3:4',
  '2:3',
  '9:16',
] as const;
export type ImageAspectRatioPreset =
  (typeof IMAGE_ASPECT_RATIO_PRESETS)[number];
// 'original' means "no fixed ratio — match the first reference image's exact
// aspect ratio", resolved dynamically in resolveImageSize() below instead of
// through the preset lookup table.
export const IMAGE_ASPECT_RATIOS = [
  'original',
  ...IMAGE_ASPECT_RATIO_PRESETS,
] as const;
export type ImageAspectRatio = (typeof IMAGE_ASPECT_RATIOS)[number];
export const DEFAULT_IMAGE_ASPECT_RATIO: ImageAspectRatio = '4:3';

// Precomputed WxH pairs per quality tier / aspect ratio. Each tier targets a
// fixed pixel budget (4K ≈ 3840x2160's 8,294,400px; 2K is a quarter of that,
// i.e. both dimensions halved) so switching aspect ratio doesn't change the
// overall image size the way a fixed long-edge would.
const IMAGE_SIZE_BY_QUALITY: Record<
  ImageQuality,
  Record<ImageAspectRatioPreset, string>
> = {
  '4k': {
    '21:9': '4396x1884',
    '16:9': '3840x2160',
    '3:2': '3528x2352',
    '4:3': '3328x2496',
    '1:1': '2880x2880',
    '3:4': '2496x3328',
    '2:3': '2352x3528',
    '9:16': '2160x3840',
  },
  '2k': {
    '21:9': '2198x942',
    '16:9': '1920x1080',
    '3:2': '1764x1176',
    '4:3': '1664x1248',
    '1:1': '1440x1440',
    '3:4': '1248x1664',
    '2:3': '1176x1764',
    '9:16': '1080x1920',
  },
};

// Same pixel budgets as the preset table above, expressed directly so an
// arbitrary ("original") ratio can be fit into them too.
const PIXEL_BUDGET: Record<ImageQuality, number> = {
  '4k': 3840 * 2160,
  '2k': 1920 * 1080,
};

/** Fit an arbitrary width:height ratio into a quality tier's pixel budget,
 * rounding to the nearest multiple of 16 like the preset table does. Used
 * for 'original' mode, which matches a reference image's exact ratio instead
 * of snapping to one of the fixed presets above. */
function computeSizeForRatio(
  quality: ImageQuality,
  refWidth: number,
  refHeight: number,
): string {
  const budget = PIXEL_BUDGET[quality];
  const ratio = refWidth > 0 && refHeight > 0 ? refWidth / refHeight : 1;
  const rawWidth = Math.sqrt(budget * ratio);
  const rawHeight = rawWidth / ratio;
  const width = Math.max(16, Math.round(rawWidth / 16) * 16);
  const height = Math.max(16, Math.round(rawHeight / 16) * 16);
  return `${width}x${height}`;
}

/** Resolve a quality tier + aspect ratio into the "WxH" string the upstream
 * Images API expects for `size`. For 'original', `refDimensions` (the first
 * reference image's actual pixel size) drives the ratio instead of a preset;
 * when it's unavailable this falls back to the 4:3 preset. */
export function resolveImageSize(
  quality: ImageQuality,
  aspectRatio: ImageAspectRatio,
  refDimensions?: { width: number; height: number },
): string {
  if (aspectRatio === 'original') {
    return refDimensions
      ? computeSizeForRatio(quality, refDimensions.width, refDimensions.height)
      : IMAGE_SIZE_BY_QUALITY[quality]['4:3'];
  }
  return IMAGE_SIZE_BY_QUALITY[quality][aspectRatio];
}

/**
 * Human-readable directive describing the requested quality/aspect ratio.
 * The `size` parameter alone isn't enough — many upstream image models treat
 * it as a loose hint (or ignore it outright) and mostly follow the natural-
 * language prompt instead, so the caller appends this sentence to the prompt
 * text to make the requirement explicit to the model itself.
 */
export function describeImageRequirements(
  quality: ImageQuality,
  aspectRatio: ImageAspectRatio,
): string {
  const qualityLabel = quality === '4k' ? '4K 高清' : '2K';
  if (aspectRatio === 'original') {
    return `请生成画质为 ${qualityLabel} 的图片，画面比例需与第一张参考图完全一致，不要裁剪、留白或改变构图比例。`;
  }
  const [w, h] = aspectRatio.split(':').map(Number);
  const orientation = w === h ? '正方形' : w > h ? '横版' : '竖版';
  return `请生成画质为 ${qualityLabel}、画面比例为 ${aspectRatio}（${orientation}）的图片。`;
}

function imageMimeType(bytes: Uint8Array): GeneratedImage['mimeType'] | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return 'image/jpeg';
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp';
  }
  return null;
}

function imageEndpoint(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/images/generations`;
}

function imageEditEndpoint(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/images/edits`;
}

function decodeImagePayload(payload: unknown): Uint8Array {
  const item = (payload as { data?: Array<{ b64_json?: unknown }> })?.data?.[0];
  if (typeof item?.b64_json !== 'string' || !item.b64_json) {
    throw new ImageGenerationError('图像服务没有返回有效图片。', 502);
  }
  const bytes = Buffer.from(item.b64_json, 'base64');
  if (!bytes.length || bytes.length > MAX_GENERATED_IMAGE_BYTES) {
    throw new ImageGenerationError('生成的图片大小无效或超过 5 MB 限制。', 502);
  }
  return bytes;
}

export class ImageGenerationError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 409 | 502 | 504,
  ) {
    super(message);
    this.name = 'ImageGenerationError';
  }
}

/**
 * Call the platform-managed OpenAI-compatible Images API directly. This is
 * intentionally independent of Agent Skills and never exposes the API key to
 * a workspace runner. With reference images the call is routed to the
 * `images/edits` endpoint (image-to-image); otherwise plain text-to-image.
 */
export async function generateWorkspaceImage(
  prompt: string,
  model: 'gpt-image-1.5' | 'gpt-image-2',
  references: ImageReference[] = [],
  size: string = '1024x1024',
): Promise<GeneratedImage> {
  const backend = getImageGenerationBackendConfig();
  if (!backend) {
    throw new ImageGenerationError('管理员尚未配置图像生成后端。', 409);
  }
  if (references.length > 0) {
    // Validate before any network I/O so bad input surfaces as 400, not 502.
    validateReferences(references);
  }

  let response: Response;
  try {
    if (references.length > 0) {
      response = await fetch(imageEditEndpoint(backend.baseUrl), {
        method: 'POST',
        headers: { Authorization: `Bearer ${backend.apiKey}` },
        body: buildEditsFormData(model, prompt, references, size),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } else {
      response = await fetch(imageEndpoint(backend.baseUrl), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${backend.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model, prompt, size }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    }
  } catch (error) {
    if (error instanceof DOMException && error.name === 'TimeoutError') {
      throw new ImageGenerationError('图像生成超时，请稍后重试。', 504);
    }
    throw new ImageGenerationError('无法连接图像生成服务，请稍后重试。', 502);
  }

  if (!response.ok) {
    const bodyText = await response.text().catch(() => '');
    let upstreamMessage: string | undefined;
    let upstreamCode: string | undefined;
    try {
      const parsedBody = JSON.parse(bodyText) as {
        error?: { message?: string; code?: string };
      };
      upstreamMessage = parsedBody?.error?.message;
      upstreamCode = parsedBody?.error?.code;
    } catch {
      // Upstream error body wasn't JSON; fall through with no parsed detail.
    }
    // The route handler swallows ImageGenerationError without logging (to
    // avoid noise for expected validation failures), so this is the only
    // place an upstream failure reason is captured for operators.
    logger.error(
      {
        status: response.status,
        upstreamCode,
        upstreamMessage,
        bodyPreview: bodyText.slice(0, 500),
      },
      'Image generation upstream returned an error response',
    );
    if (upstreamCode === 'moderation_blocked') {
      throw new ImageGenerationError(
        '生成请求被上游内容安全审核拦截（可能涉及受版权保护的角色/IP 或敏感内容），请调整提示词或参考图后重试。',
        400,
      );
    }
    throw new ImageGenerationError(
      '图像生成服务未能完成请求，请稍后重试。',
      502,
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new ImageGenerationError('图像服务返回了无效响应。', 502);
  }
  const bytes = decodeImagePayload(payload);
  const mimeType = imageMimeType(bytes);
  if (!mimeType) {
    throw new ImageGenerationError('图像服务返回了不支持的文件格式。', 502);
  }

  return { data: Buffer.from(bytes).toString('base64'), mimeType };
}

const REFERENCE_EXTENSION: Record<ImageReference['mimeType'], string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

function validateReferences(references: ImageReference[]): void {
  if (references.length > MAX_REFERENCE_IMAGES) {
    throw new ImageGenerationError(
      `参考图最多 ${MAX_REFERENCE_IMAGES} 张。`,
      400,
    );
  }
  for (const ref of references) {
    if (!ref.data.length || ref.data.length > MAX_REFERENCE_IMAGE_BYTES) {
      throw new ImageGenerationError(
        `参考图大小无效或超过 ${MAX_REFERENCE_IMAGE_BYTES / 1024 / 1024} MB 限制。`,
        400,
      );
    }
    if (!imageMimeType(ref.data) || !(ref.mimeType in REFERENCE_EXTENSION)) {
      throw new ImageGenerationError('参考图仅支持 PNG、JPEG 或 WebP。', 400);
    }
  }
}

/**
 * Build the multipart body for the `images/edits` endpoint. The
 * OpenAI-compatible upstream accepts repeated `image[]` fields for multiple
 * reference images.
 */
function buildEditsFormData(
  model: 'gpt-image-1.5' | 'gpt-image-2',
  prompt: string,
  references: ImageReference[],
  size: string,
): FormData {
  const form = new FormData();
  form.set('model', model);
  form.set('prompt', prompt);
  form.set('size', size);
  references.forEach((ref, index) => {
    form.append(
      'image[]',
      new Blob([new Uint8Array(ref.data)], { type: ref.mimeType }),
      `reference-${index + 1}.${REFERENCE_EXTENSION[ref.mimeType]}`,
    );
  });
  return form;
}
