import {
  acquireExternalCapabilityVaultExclusiveLock,
  acquireExternalCapabilityVaultSharedLock,
} from '../src/external-capability-vault-lock.js';

const [mode, vaultRoot, vaultId, dataDir, leakValue] = process.argv.slice(2);
if (!mode || !vaultRoot || !vaultId || !dataDir) {
  throw new Error('Missing Vault lock child arguments');
}

const env = {
  ...process.env,
  EXTERNAL_CAPABILITY_VAULT_DIR: vaultRoot,
  EXTERNAL_CAPABILITY_VAULT_ID: vaultId,
};
const leak = leakValue === 'leak';

try {
  if (mode === 'shared') {
    const lock = acquireExternalCapabilityVaultSharedLock(env, dataDir);
    process.stdout.write(`${JSON.stringify({ acquired: lock !== null })}\n`);
    if (lock && !leak) lock.release();
  } else if (mode === 'exclusive') {
    const lock = acquireExternalCapabilityVaultExclusiveLock(env, dataDir);
    process.stdout.write(`${JSON.stringify({ acquired: true })}\n`);
    if (!leak) lock.release();
  } else {
    throw new Error(`Unknown Vault lock child mode: ${mode}`);
  }
} catch (error) {
  process.stdout.write(
    `${JSON.stringify({
      acquired: false,
      error: error instanceof Error ? error.message : String(error),
    })}\n`,
  );
}
