import { getImageGenerationBackendConfig } from './runtime-config.js';

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
        body: buildEditsFormData(model, prompt, references),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } else {
      response = await fetch(imageEndpoint(backend.baseUrl), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${backend.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model, prompt, size: '1024x1024' }),
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
): FormData {
  const form = new FormData();
  form.set('model', model);
  form.set('prompt', prompt);
  references.forEach((ref, index) => {
    form.append(
      'image[]',
      new Blob([new Uint8Array(ref.data)], { type: ref.mimeType }),
      `reference-${index + 1}.${REFERENCE_EXTENSION[ref.mimeType]}`,
    );
  });
  return form;
}
