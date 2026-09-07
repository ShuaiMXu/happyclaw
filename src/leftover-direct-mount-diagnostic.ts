import type Database from 'better-sqlite3';

import {
  channelConversationJid,
  parseChannelAddress,
} from './channel-address.js';
import { resolveChannelConversationKind } from './channel-conversation-kind.js';
import {
  canonicalizeWhatsAppConversationJid,
  canonicalizeWhatsAppProviderConversationJid,
  isLegacyWhatsAppDirectConversationJid,
  resolveWhatsAppConversationAliasFromGroups,
  whatsAppAliasRoutingSignature,
  type WhatsAppAliasRoutingMetadata,
} from './whatsapp-jid.js';

export interface LeftoverDirectWorkspaceMount {
  channelJid: string;
  workspaceJid: string;
  workspaceFolder: string;
  channelAccountId?: string;
  mainOwnerJid?: string;
  mainOwnerIsThisChat: boolean;
  mainSessionId?: string;
  existingIsolationMarker?: string;
  recoverableInboundFromThisChat: number;
}

export interface AffectedLeftoverWorkspace {
  workspaceJid: string;
  workspaceFolder: string;
  leftoverCount: number;
  existingIsolationMarker?: string;
  mainSessionId?: string;
  mainRuntimeSessionId?: string;
  mainOwnerJid?: string;
  recoverableInboundFromLeftovers: number;
}

export interface LeftoverDirectMountDiagnosis {
  schemaVersion: string;
  leftovers: LeftoverDirectWorkspaceMount[];
  affectedWorkspaces: AffectedLeftoverWorkspace[];
  aliasConflicts: LeftoverDirectAliasConflict[];
}

export interface LeftoverDirectAliasConflict {
  canonicalJid: string;
  aliases: string[];
  reason: 'routing_metadata_mismatch';
  manualAction: string;
}

interface DiagnosticGroupRow {
  jid: string;
  name: string;
  folder: string;
  created_by: string | null;
  channel_account_id: string | null;
  target_agent_id: string | null;
  target_main_jid: string | null;
  owner_im_id: string | null;
  owner_claim_source: string | null;
  binding_mode: string | null;
  reply_policy: string | null;
  require_mention: number | null;
  activation_mode: string | null;
  audience_mode: string | null;
  sender_allowlist: string | null;
}

type DiagnosticDatabase = Pick<Database.Database, 'prepare'>;

function optional(value: string | null | undefined): string | undefined {
  return value || undefined;
}

/**
 * Match account-scoped, legacy-unscoped and provider-normalized forms of the
 * same external conversation. Non-empty, different account IDs never alias.
 * This stays suffix-agnostic: adding a new direct JID to the central classifier
 * automatically makes the diagnostic discover it without another migration.
 */
export function sourceMatchesChannelConversation(
  sourceJid: string,
  conversationJid: string,
): boolean {
  const canonicalSource = canonicalizeWhatsAppConversationJid(
    channelConversationJid(sourceJid),
  );
  const canonicalConversation = canonicalizeWhatsAppConversationJid(
    channelConversationJid(conversationJid),
  );
  if (
    sourceJid === conversationJid ||
    canonicalSource === canonicalConversation
  ) {
    return true;
  }
  const source = parseChannelAddress(sourceJid);
  const conversation = parseChannelAddress(conversationJid);
  if (!source || !conversation) return false;
  const sourceExternal =
    source.provider === 'whatsapp'
      ? canonicalizeWhatsAppProviderConversationJid(source.externalChatId)
      : source.externalChatId;
  const conversationExternal =
    conversation.provider === 'whatsapp'
      ? canonicalizeWhatsAppProviderConversationJid(conversation.externalChatId)
      : conversation.externalChatId;
  if (
    source.provider !== conversation.provider ||
    sourceExternal !== conversationExternal
  ) {
    return false;
  }
  return (
    !source.channelAccountId ||
    !conversation.channelAccountId ||
    source.channelAccountId === conversation.channelAccountId
  );
}

function parseSenderAllowlist(value: string | null): string[] | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === 'string')
      : null;
  } catch {
    return null;
  }
}

function diagnosticAliasMetadata(
  row: DiagnosticGroupRow,
): WhatsAppAliasRoutingMetadata {
  return {
    folder: row.folder,
    created_by: optional(row.created_by),
    channel_account_id: optional(row.channel_account_id),
    target_main_jid: optional(row.target_main_jid),
    target_agent_id: optional(row.target_agent_id),
    owner_im_id: optional(row.owner_im_id),
    owner_claim_source: optional(row.owner_claim_source),
    binding_mode: optional(row.binding_mode),
    reply_policy: optional(row.reply_policy),
    require_mention: row.require_mention === 1,
    activation_mode: optional(row.activation_mode),
    audience_mode: optional(row.audience_mode),
    sender_allowlist: parseSenderAllowlist(row.sender_allowlist),
  };
}

/**
 * Identify aliases whose owner/workspace/session routing differs. The repair
 * must never guess which route wins; operators must explicitly unbind the
 * conflicting rows first.
 */
export function findWhatsAppAliasRoutingConflicts(
  groups: Readonly<Record<string, WhatsAppAliasRoutingMetadata>>,
): LeftoverDirectAliasConflict[] {
  const legacyByCanonical = new Map<string, string[]>();
  for (const jid of Object.keys(groups)) {
    if (!isLegacyWhatsAppDirectConversationJid(jid)) continue;
    const canonical = canonicalizeWhatsAppConversationJid(jid);
    const aliases = legacyByCanonical.get(canonical) ?? [];
    aliases.push(jid);
    legacyByCanonical.set(canonical, aliases);
  }

  const conflicts: LeftoverDirectAliasConflict[] = [];
  for (const [canonicalJid, unsortedAliases] of legacyByCanonical) {
    const aliases = [...unsortedAliases].sort();
    const legacyGroups = Object.fromEntries(
      aliases.map((alias) => [alias, groups[alias]!]),
    );
    const resolution = resolveWhatsAppConversationAliasFromGroups(
      canonicalJid,
      legacyGroups,
    );
    const candidates = groups[canonicalJid]
      ? [canonicalJid, ...aliases]
      : aliases;
    const signatures = new Set(
      candidates.map((candidate) =>
        whatsAppAliasRoutingSignature(groups[candidate]!),
      ),
    );
    if (resolution.status !== 'conflict' && signatures.size === 1) continue;
    conflicts.push({
      canonicalJid,
      aliases: candidates,
      reason: 'routing_metadata_mismatch',
      manualAction:
        'Manually unbind the conflicting WhatsApp aliases, then rerun the diagnostic; automatic repair will not choose an owner, workspace, or session.',
    });
  }
  return conflicts.sort((a, b) => a.canonicalJid.localeCompare(b.canonicalJid));
}

function routerState(db: DiagnosticDatabase, key: string): string | undefined {
  return optional(
    (
      db.prepare('SELECT value FROM router_state WHERE key = ?').get(key) as
        | { value: string }
        | undefined
    )?.value,
  );
}

export function readDatabaseSchemaVersion(
  db: DiagnosticDatabase,
): string | undefined {
  return routerState(db, 'schema_version');
}

/** Query-only repository shared by the in-memory dry-run and write repair. */
export function diagnoseLeftoverDirectMountsFromDatabase(
  db: DiagnosticDatabase,
  expectedSchemaVersion: number,
): LeftoverDirectMountDiagnosis {
  const schemaVersion = readDatabaseSchemaVersion(db);
  if (schemaVersion !== String(expectedSchemaVersion)) {
    throw new Error(
      `Repair requires schema v${expectedSchemaVersion}; database is ${schemaVersion ? `v${schemaVersion}` : 'unversioned'}. Start the matching supported HappyClaw release normally before running this tool; the tool will not migrate or back up the database.`,
    );
  }

  const rows = db
    .prepare(
      `SELECT jid, name, folder, created_by, channel_account_id,
              target_agent_id, target_main_jid, owner_im_id,
              owner_claim_source, binding_mode, reply_policy, require_mention,
              activation_mode, audience_mode, sender_allowlist
       FROM registered_groups`,
    )
    .all() as DiagnosticGroupRow[];
  const groups = new Map(rows.map((row) => [row.jid, row]));
  const aliasGroups = Object.fromEntries(
    rows.map((row) => [row.jid, diagnosticAliasMetadata(row)]),
  );
  const aliasConflicts = findWhatsAppAliasRoutingConflicts(aliasGroups);
  const workspaceByFolder = new Map<string, DiagnosticGroupRow>();
  for (const row of rows) {
    if (row.jid.startsWith('web:') && !workspaceByFolder.has(row.folder)) {
      workspaceByFolder.set(row.folder, row);
    }
  }

  const sourceCountsByWorkspace = new Map<
    string,
    Array<{ sourceJid: string; count: number }>
  >();
  const sourceCounts = (workspaceJid: string) => {
    const cached = sourceCountsByWorkspace.get(workspaceJid);
    if (cached) return cached;
    const loaded = (
      db
        .prepare(
          `SELECT source_jid, COUNT(*) AS count
           FROM messages
           WHERE chat_jid = ? AND is_from_me = 0
             AND history_recovery_allowed = 1 AND source_jid IS NOT NULL
           GROUP BY source_jid`,
        )
        .all(workspaceJid) as Array<{
        source_jid: string;
        count: number;
      }>
    ).map((row) => ({
      sourceJid: row.source_jid,
      count: Number(row.count),
    }));
    sourceCountsByWorkspace.set(workspaceJid, loaded);
    return loaded;
  };

  const leftovers: LeftoverDirectWorkspaceMount[] = [];
  for (const row of rows) {
    if (resolveChannelConversationKind(row.jid) !== 'direct') continue;
    if (!row.target_main_jid || row.target_agent_id) continue;
    const workspace =
      groups.get(row.target_main_jid) ??
      (row.target_main_jid.startsWith('web:')
        ? workspaceByFolder.get(row.target_main_jid.slice(4))
        : undefined);
    if (!workspace) continue;

    const ownerKey = `channel_session_owner:${workspace.folder}:main`;
    const mainOwnerJid = routerState(db, ownerKey);
    const mainSessionId = optional(
      (
        db
          .prepare(
            "SELECT session_id FROM sessions WHERE group_folder = ? AND agent_id = ''",
          )
          .get(workspace.folder) as { session_id: string } | undefined
      )?.session_id,
    );
    const existingIsolationMarker = routerState(
      db,
      `conversation_history_isolation:${workspace.jid}`,
    );
    const recoverableInboundFromThisChat = sourceCounts(workspace.jid)
      .filter((source) =>
        sourceMatchesChannelConversation(source.sourceJid, row.jid),
      )
      .reduce((sum, source) => sum + source.count, 0);

    leftovers.push({
      channelJid: row.jid,
      workspaceJid: workspace.jid,
      workspaceFolder: workspace.folder,
      channelAccountId: optional(row.channel_account_id),
      mainOwnerJid,
      mainOwnerIsThisChat: Boolean(
        mainOwnerJid && sourceMatchesChannelConversation(mainOwnerJid, row.jid),
      ),
      mainSessionId,
      existingIsolationMarker,
      recoverableInboundFromThisChat,
    });
  }

  const byWorkspace = new Map<string, LeftoverDirectWorkspaceMount[]>();
  for (const leftover of leftovers) {
    const mounts = byWorkspace.get(leftover.workspaceJid) ?? [];
    mounts.push(leftover);
    byWorkspace.set(leftover.workspaceJid, mounts);
  }
  const affectedWorkspaces: AffectedLeftoverWorkspace[] = [];
  for (const [workspaceJid, mounts] of byWorkspace) {
    const folder = mounts[0]!.workspaceFolder;
    affectedWorkspaces.push({
      workspaceJid,
      workspaceFolder: folder,
      leftoverCount: mounts.length,
      existingIsolationMarker: routerState(
        db,
        `conversation_history_isolation:${workspaceJid}`,
      ),
      mainSessionId: optional(
        (
          db
            .prepare(
              "SELECT session_id FROM sessions WHERE group_folder = ? AND agent_id = ''",
            )
            .get(folder) as { session_id: string } | undefined
        )?.session_id,
      ),
      mainRuntimeSessionId: optional(
        (
          db
            .prepare(
              "SELECT sdk_session_id FROM workspace_runtime_sessions WHERE group_folder = ? AND runtime_agent_id = ''",
            )
            .get(folder) as { sdk_session_id: string } | undefined
        )?.sdk_session_id,
      ),
      mainOwnerJid: routerState(db, `channel_session_owner:${folder}:main`),
      recoverableInboundFromLeftovers: sourceCounts(workspaceJid)
        .filter((source) =>
          mounts.some((mount) =>
            sourceMatchesChannelConversation(
              source.sourceJid,
              mount.channelJid,
            ),
          ),
        )
        .reduce((sum, source) => sum + source.count, 0),
    });
  }

  return { schemaVersion, leftovers, affectedWorkspaces, aliasConflicts };
}
