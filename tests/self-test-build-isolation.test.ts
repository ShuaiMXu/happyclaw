import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const root = process.cwd();
const read = (relativePath: string) =>
  fs.readFileSync(path.join(root, relativePath), 'utf8');

describe('self-test Web build isolation', () => {
  test('keeps verification builds away from the production Web directory', () => {
    const packageJson = JSON.parse(read('package.json')) as {
      scripts: Record<string, string>;
    };
    const scripts = packageJson.scripts;

    expect(scripts['self-test']).toContain('npm run build:all:check');
    expect(scripts['build:all:check']).toContain('npm run build:web:check');
    expect(scripts['build:web:check']).toBe(
      'node scripts/build-web-isolated.mjs',
    );
    expect(scripts['build:all']).toContain('npm run build:web');
    expect(scripts['build:all']).not.toContain('npm run build:web:check');

    const isolatedBuild = read('scripts/build-web-isolated.mjs');
    expect(isolatedBuild).toContain('mkdtemp(');
    expect(isolatedBuild).toContain("'--outDir'");
    expect(isolatedBuild).toContain('await rm(outputRoot');
    expect(isolatedBuild).not.toContain("path.join(root, 'web', 'dist')");
  });
});
