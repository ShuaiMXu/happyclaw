import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const read = (file: string) =>
  fs.readFileSync(path.join(process.cwd(), file), 'utf8');

describe('Mac mini production deployment contract', () => {
  test('links the executable runbook and preserves runtime data', () => {
    const agents = read('AGENTS.md');
    const deployment = read('DEPLOYMENT.md');

    expect(agents).toContain('[DEPLOYMENT.md](DEPLOYMENT.md)');
    expect(deployment).toContain('/Users/riba2534/airepo/happyclaw');
    expect(deployment).toContain('com.riba2534.happyclaw');
    expect(agents).toContain('opted out of deployment backups');
    expect(deployment).toContain('不得运行 `make backup`');
    expect(deployment).toContain('HAPPYCLAW_SKIP_MIGRATION_BACKUP=1');
    expect(deployment).not.toContain(
      'BACKUP_DIR="$HOME/happyclaw-deploy-backups" make backup',
    );
    expect(deployment).not.toContain('env-before-$HAPPYCLAW_EXPECTED_SHA');
    expect(deployment).toContain('npm run build:all');
    expect(deployment).toContain('launchctl kickstart -k');
    expect(deployment).toContain('/api/health');
    expect(deployment).toContain('/api/config/appearance/public');
    expect(deployment).toContain('HAPPYCLAW_PREVIOUS_SHA');
    expect(deployment).not.toMatch(
      /^\s*(?:git clean|git reset --hard|make reset-init)\b/m,
    );
  });
});
