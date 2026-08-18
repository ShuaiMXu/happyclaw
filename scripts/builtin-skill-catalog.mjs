import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const CATALOG_SCHEMA_VERSION = 2;

/**
 * Fixed-version upstream sources that contribute Skills into
 * data/builtin-skills/. Each entry is a full repo tag pinned by content hash,
 * matching the model `feishu-cli` established: fetch a specific tag's source
 * tarball, verify its sha256 before extracting anything, then merge the
 * relevant Skill directories into one staging tree before writeCatalog().
 *
 * install-host-tools.sh is bash and cannot import this module, so the same
 * name/version/sourceSha256 triples are duplicated there. A mismatch between
 * the two is caught by tests/builtin-skill-bootstrap-contract.test.ts.
 */
export const BUILTIN_SKILL_SOURCES = [
  {
    name: 'feishu-cli',
    version: 'v1.35.0',
    sourceSha256:
      '91b5575833f003527c7b60a26f08703ebfdb348098deecfa9ceed1dcf230f253',
  },
  {
    name: 'baoyu-skills',
    version: 'v2.5.2',
    sourceSha256:
      'b7e88f4183289cc1e5e4635e3746fac3ccd5db4e0beb25e38bb84c01aad885cb',
  },
];

// Back-compat named exports for callers that only ever cared about the
// original (and still first) source.
export const FEISHU_CLI_VERSION = BUILTIN_SKILL_SOURCES[0].version;
export const FEISHU_CLI_SOURCE_SHA256 = BUILTIN_SKILL_SOURCES[0].sourceSha256;

const MARKER_NAME = '.catalog.json';
const IGNORED = new Set([
  MARKER_NAME,
  '.DS_Store',
  '.cache',
  '.git',
  '__pycache__',
  'node_modules',
]);

function payloadHash(root) {
  const hash = createHash('sha256');
  const visit = (directory, relativeRoot) => {
    const entries = fs
      .readdirSync(directory, { withFileTypes: true })
      .filter((entry) => !IGNORED.has(entry.name))
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relativePath = relativeRoot
        ? path.posix.join(relativeRoot, entry.name)
        : entry.name;
      const absolutePath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        hash.update(
          `symlink\0${relativePath}\0${fs.readlinkSync(absolutePath)}\0`,
        );
      } else if (entry.isDirectory()) {
        hash.update(`directory\0${relativePath}\0`);
        visit(absolutePath, relativePath);
      } else if (entry.isFile()) {
        hash.update(`file\0${relativePath}\0`);
        hash.update(fs.readFileSync(absolutePath));
        hash.update('\0');
      }
    }
  };
  visit(root, '');
  return hash.digest('hex');
}

function skillIds(root) {
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .filter((entry) => fs.existsSync(path.join(root, entry.name, 'SKILL.md')))
    .map((entry) => entry.name)
    .sort();
}

export function writeCatalog(root) {
  const ids = skillIds(root);
  if (ids.length === 0) throw new Error('builtin Skill catalog is empty');
  const marker = {
    schemaVersion: CATALOG_SCHEMA_VERSION,
    sources: BUILTIN_SKILL_SOURCES,
    payloadHash: payloadHash(root),
    skillIds: ids,
  };
  fs.writeFileSync(
    path.join(root, MARKER_NAME),
    `${JSON.stringify(marker, null, 2)}\n`,
  );
  return marker;
}

export function validateCatalog(root) {
  try {
    const marker = JSON.parse(
      fs.readFileSync(path.join(root, MARKER_NAME), 'utf8'),
    );
    const actualIds = skillIds(root);
    return (
      marker.schemaVersion === CATALOG_SCHEMA_VERSION &&
      JSON.stringify(marker.sources) ===
        JSON.stringify(BUILTIN_SKILL_SOURCES) &&
      marker.payloadHash === payloadHash(root) &&
      JSON.stringify(marker.skillIds) === JSON.stringify(actualIds) &&
      actualIds.length > 0
    );
  } catch {
    return false;
  }
}

const [action, rootArg] = process.argv.slice(2);
if (action === 'write' || action === 'validate') {
  const root = path.resolve(rootArg || 'data/builtin-skills');
  if (action === 'write') {
    writeCatalog(root);
  } else if (!validateCatalog(root)) {
    process.exitCode = 1;
  }
}
