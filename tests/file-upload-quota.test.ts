import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, test, vi } from 'vitest';

const tmpDir = fs.mkdtempSync(
  path.join(os.tmpdir(), 'happyclaw-upload-quota-'),
);
const groupsDir = path.join(tmpDir, 'groups');
const workspaceDir = path.join(groupsDir, 'quota-workspace');
fs.mkdirSync(workspaceDir, { recursive: true });

const billingMocks = vi.hoisted(() => ({
  checkStorageLimit: vi.fn(),
}));

vi.mock('../src/config.js', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return {
    ...real,
    DATA_DIR: tmpDir,
    GROUPS_DIR: groupsDir,
    STORE_DIR: path.join(tmpDir, 'db'),
  };
});

vi.mock('../src/logger.js', () => ({
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
}));

vi.mock('../src/middleware/auth.ts', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('user', {
      id: 'quota-user',
      username: 'quota-user',
      role: 'member',
      status: 'active',
      permissions: [],
    });
    return next();
  },
}));

vi.mock('../src/db.js', () => ({
  getRegisteredGroup: (jid: string) =>
    jid === 'web:quota'
      ? {
          jid,
          name: 'Quota workspace',
          folder: 'quota-workspace',
          added_at: '2026-08-17T00:00:00.000Z',
          executionMode: 'container',
          created_by: 'quota-user',
          is_home: false,
        }
      : undefined,
}));

vi.mock('../src/web-context.js', () => ({
  canAccessGroup: () => true,
  isHostExecutionGroup: () => false,
  hasHostExecutionPermission: () => true,
}));

vi.mock('../src/billing.js', () => ({
  isBillingEnabled: () => true,
  checkStorageLimit: billingMocks.checkStorageLimit,
}));

const routes = (await import('../src/routes/files.js')).default;
const { invalidateGroupStorageUsage } = await import('../src/file-manager.js');

const LIMIT_BYTES = 1_000_000;

function uploadRequest(files: File[]): Request {
  const body = new FormData();
  for (const file of files) body.append('files', file);
  return new Request('http://localhost/web%3Aquota/files', {
    method: 'POST',
    body,
  });
}

function makeFile(name: string, size: number): File {
  return new File([Buffer.alloc(size, 0x61)], name, {
    type: 'application/octet-stream',
  });
}

async function upload(files: File[]) {
  return routes.request(uploadRequest(files));
}

beforeEach(() => {
  fs.rmSync(workspaceDir, { recursive: true, force: true });
  fs.mkdirSync(workspaceDir, { recursive: true });
  invalidateGroupStorageUsage('quota-workspace');
  billingMocks.checkStorageLimit.mockReset();
  billingMocks.checkStorageLimit.mockImplementation(
    (_userId, _role, currentBytes: number, additionalBytes: number) =>
      currentBytes + additionalBytes > LIMIT_BYTES
        ? { allowed: false, reason: 'quota exceeded' }
        : { allowed: true },
  );
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('上传同名不覆盖（自动改名）且按新增文件全额计费', () => {
  test('同名文件重复上传会自动改名保留两份，不做覆盖去重', async () => {
    // 同名不覆盖之后，"重试同一次上传"不再天然幂等——两次请求会各自落成一个
    // 独立文件（large.bin / large-1.bin），这是"绝不覆盖已有内容"这条新规则
    // 带来的已知取舍：网络问题导致的真实重试可能留下一份重复文件，但比起
    // 悄悄覆盖用户已有内容，这个代价是可接受的。
    const first = await upload([makeFile('large.bin', 400_000)]);
    const second = await upload([makeFile('large.bin', 400_000)]);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(billingMocks.checkStorageLimit).toHaveBeenCalledTimes(2);
    expect(fs.statSync(path.join(workspaceDir, 'large.bin')).size).toBe(
      400_000,
    );
    expect(fs.statSync(path.join(workspaceDir, 'large-1.bin')).size).toBe(
      400_000,
    );
  });

  test('同名文件自动改名后按新文件的完整大小计费，不再按新旧差值计费', async () => {
    fs.writeFileSync(
      path.join(workspaceDir, 'large.bin'),
      Buffer.alloc(400_000),
    );

    const response = await upload([makeFile('large.bin', 450_000)]);

    expect(response.status).toBe(200);
    expect(billingMocks.checkStorageLimit).toHaveBeenCalledWith(
      'quota-user',
      'member',
      400_000,
      450_000,
    );
    expect(fs.statSync(path.join(workspaceDir, 'large.bin')).size).toBe(
      400_000,
    );
    expect(fs.statSync(path.join(workspaceDir, 'large-1.bin')).size).toBe(
      450_000,
    );
  });

  test('同批次里同名文件与全新文件都按各自完整大小计费，互不抵扣', async () => {
    fs.writeFileSync(
      path.join(workspaceDir, 'existing.bin'),
      Buffer.alloc(400_000),
    );

    const response = await upload([
      makeFile('existing.bin', 300_000),
      makeFile('new.bin', 300_000),
    ]);

    expect(response.status).toBe(200);
    expect(billingMocks.checkStorageLimit).toHaveBeenCalledWith(
      'quota-user',
      'member',
      400_000,
      600_000,
    );
    expect(fs.statSync(path.join(workspaceDir, 'existing.bin')).size).toBe(
      400_000,
    );
    expect(fs.statSync(path.join(workspaceDir, 'existing-1.bin')).size).toBe(
      300_000,
    );
    expect(fs.statSync(path.join(workspaceDir, 'new.bin')).size).toBe(300_000);
  });

  test('同一批次内的同名文件各自改名保留，不会互相覆盖', async () => {
    fs.writeFileSync(
      path.join(workspaceDir, 'same.bin'),
      Buffer.alloc(400_000),
    );

    const response = await upload([
      makeFile('same.bin', 300_000),
      makeFile('same.bin', 300_000),
    ]);

    expect(response.status).toBe(200);
    expect(billingMocks.checkStorageLimit).toHaveBeenCalledWith(
      'quota-user',
      'member',
      400_000,
      600_000,
    );
    expect(fs.statSync(path.join(workspaceDir, 'same.bin')).size).toBe(400_000);
    expect(fs.statSync(path.join(workspaceDir, 'same-1.bin')).size).toBe(
      300_000,
    );
    expect(fs.statSync(path.join(workspaceDir, 'same-2.bin')).size).toBe(
      300_000,
    );
  });

  test('文件名与已有目录同名时自动改名，不拒绝、不影响目录也不影响批次里其它文件', async () => {
    fs.mkdirSync(path.join(workspaceDir, 'occupied'));

    const response = await upload([
      makeFile('would-have-been-written.bin', 10),
      makeFile('occupied', 10),
    ]);

    expect(response.status).toBe(200);
    expect(
      fs.existsSync(path.join(workspaceDir, 'would-have-been-written.bin')),
    ).toBe(true);
    expect(fs.statSync(path.join(workspaceDir, 'occupied')).isDirectory()).toBe(
      true,
    );
    expect(fs.statSync(path.join(workspaceDir, 'occupied-1')).isFile()).toBe(
      true,
    );
  });

  test('文件名与已有 symlink 同名时自动改名，不会覆盖或跟随该链接', async () => {
    fs.writeFileSync(path.join(workspaceDir, 'real.bin'), Buffer.alloc(10));
    fs.symlinkSync('real.bin', path.join(workspaceDir, 'linked.bin'));

    const response = await upload([makeFile('linked.bin', 10)]);

    expect(response.status).toBe(200);
    expect(
      fs.lstatSync(path.join(workspaceDir, 'linked.bin')).isSymbolicLink(),
    ).toBe(true);
    expect(fs.lstatSync(path.join(workspaceDir, 'linked-1.bin')).isFile()).toBe(
      true,
    );
  });

  test('并发请求串行检查配额，只有一个 600KB 新文件可通过', async () => {
    const [a, b] = await Promise.all([
      upload([makeFile('a.bin', 600_000)]),
      upload([makeFile('b.bin', 600_000)]),
    ]);

    expect([a.status, b.status].sort()).toEqual([200, 403]);
    const written = ['a.bin', 'b.bin'].filter((name) =>
      fs.existsSync(path.join(workspaceDir, name)),
    );
    expect(written).toHaveLength(1);
  });

  test('部分写入后续文件读取失败时失效配额缓存', async () => {
    const originalArrayBuffer = File.prototype.arrayBuffer;
    const arrayBufferSpy = vi
      .spyOn(File.prototype, 'arrayBuffer')
      .mockImplementation(function (this: File) {
        if (this.name === 'fail.bin') {
          return Promise.reject(new Error('simulated file read failure'));
        }
        return originalArrayBuffer.call(this);
      });

    try {
      const partial = await upload([
        makeFile('written.bin', 600_000),
        makeFile('fail.bin', 1),
      ]);
      expect(partial.status).toBe(500);
      expect(fs.statSync(path.join(workspaceDir, 'written.bin')).size).toBe(
        600_000,
      );

      const next = await upload([makeFile('next.bin', 600_000)]);
      expect(next.status).toBe(403);
      expect(fs.existsSync(path.join(workspaceDir, 'next.bin'))).toBe(false);
    } finally {
      arrayBufferSpy.mockRestore();
    }
  });
});
