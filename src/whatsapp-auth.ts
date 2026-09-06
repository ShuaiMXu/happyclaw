import fs from 'node:fs';
import path from 'node:path';

const SAFE_AUTH_PATH_SEGMENT = /^[A-Za-z0-9_-]{1,64}$/;

function safeAuthPathSegment(
  value: string | undefined,
  fallback?: string,
): string {
  const resolved = value || fallback;
  if (!resolved || !SAFE_AUTH_PATH_SEGMENT.test(resolved)) {
    throw new Error('Invalid WhatsApp auth path segment');
  }
  return resolved;
}

/** Compute the auth state directory without loading the Baileys connector. */
export function getWhatsAppAuthDir(
  dataDir: string,
  userId: string,
  accountId = 'default',
): string {
  const safeUserId = safeAuthPathSegment(userId);
  const safeAccountId = safeAuthPathSegment(accountId, 'default');
  const root = path.resolve(
    dataDir,
    'config',
    'user-im',
    safeUserId,
    'whatsapp-auth',
  );
  const candidate = path.resolve(root, safeAccountId);
  if (!candidate.startsWith(`${root}${path.sep}`)) {
    throw new Error('WhatsApp auth directory escaped its account root');
  }
  return candidate;
}

/** Move a legacy singleton auth state to the immutable channel-account id. */
export function migrateLegacyWhatsAppAuthDir(
  dataDir: string,
  userId: string,
  legacyAccountId: string | undefined,
  channelAccountId: string,
): boolean {
  if (!legacyAccountId || legacyAccountId === channelAccountId) return false;
  let source: string;
  let destination: string;
  try {
    source = getWhatsAppAuthDir(dataDir, userId, legacyAccountId);
    destination = getWhatsAppAuthDir(dataDir, userId, channelAccountId);
  } catch {
    return false;
  }
  if (!fs.existsSync(source) || fs.existsSync(destination)) return false;
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  try {
    fs.renameSync(source, destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    fs.cpSync(source, destination, { recursive: true });
    fs.rmSync(source, { recursive: true, force: true });
  }
  return true;
}
