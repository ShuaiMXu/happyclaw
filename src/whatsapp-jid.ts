import { jidNormalizedUser } from 'baileys';

import { parseChannelAddress } from './channel-address.js';

const WHATSAPP_PREFIX = 'whatsapp:';
const LEGACY_USER_SUFFIX = '@c.us';
const DIRECT_USER_SUFFIXES = [
  '@s.whatsapp.net',
  '@hosted.lid',
  '@lid',
  '@hosted',
  LEGACY_USER_SUFFIX,
] as const;

/** Whether a provider-native WhatsApp JID is a structurally direct user chat. */
export function isWhatsAppDirectProviderJid(jid: string): boolean {
  return DIRECT_USER_SUFFIXES.some((suffix) => jid.endsWith(suffix));
}

/**
 * Collapse device/agent suffixes and the legacy `@c.us` PN domain before a
 * WhatsApp conversation becomes a HappyClaw identity. The raw provider target
 * must remain available to the transport for acknowledgements and immediate
 * replies; this helper defines only the durable logical identity.
 */
export function canonicalizeWhatsAppProviderConversationJid(
  jid: string,
): string {
  if (!isWhatsAppDirectProviderJid(jid)) return jid;
  return jidNormalizedUser(jid) || jid;
}

/** Canonicalize a HappyClaw WhatsApp conversation JID while preserving scope. */
export function canonicalizeWhatsAppConversationJid(jid: string): string {
  const address = parseChannelAddress(jid);
  if (!address || address.provider !== 'whatsapp') return jid;
  const canonicalExternal = canonicalizeWhatsAppProviderConversationJid(
    address.externalChatId,
  );
  if (canonicalExternal === address.externalChatId) return jid;
  const fragmentOffset = jid.indexOf('#');
  const fragments = fragmentOffset >= 0 ? jid.slice(fragmentOffset) : '';
  return `${WHATSAPP_PREFIX}${canonicalExternal}${fragments}`;
}

/** True only for the legacy direct-chat aliases that need data reconciliation. */
export function isLegacyWhatsAppDirectConversationJid(jid: string): boolean {
  const address = parseChannelAddress(jid);
  return (
    address?.provider === 'whatsapp' &&
    address.externalChatId.endsWith(LEGACY_USER_SUFFIX)
  );
}

/**
 * Locate account-scoped legacy aliases for one canonical conversation. This is
 * intentionally exact after canonicalization: the account fragment remains in
 * the identity, so two bots talking to the same phone number never coalesce.
 */
export function findLegacyWhatsAppConversationAliases(
  canonicalJid: string,
  candidates: Iterable<string>,
): string[] {
  const canonical = canonicalizeWhatsAppConversationJid(canonicalJid);
  const aliases: string[] = [];
  for (const candidate of candidates) {
    if (!isLegacyWhatsAppDirectConversationJid(candidate)) continue;
    if (canonicalizeWhatsAppConversationJid(candidate) === canonical) {
      aliases.push(candidate);
    }
  }
  return aliases;
}

export type WhatsAppConversationAliasResolution =
  | { status: 'canonical' | 'new'; jid: string; aliases: [] }
  | { status: 'legacy'; jid: string; aliases: [string] }
  | { status: 'legacy_equivalent'; jid: string; aliases: string[] }
  | { status: 'conflict'; jid: null; aliases: string[] };

export interface WhatsAppAliasRoutingMetadata {
  folder: string;
  created_by?: string;
  channel_account_id?: string;
  target_main_jid?: string;
  target_agent_id?: string;
  owner_im_id?: string;
  owner_claim_source?: string;
  binding_mode?: string;
  reply_policy?: string;
  require_mention?: boolean;
  activation_mode?: string;
  audience_mode?: string;
  sender_allowlist?: readonly string[] | null;
}

/**
 * Resolve an inbound logical identity without mutating persisted data. A lone
 * legacy alias keeps its exact key so pairing, active turns, and route lookups
 * remain stable. Once a canonical row exists it wins. Multiple legacy rows are
 * ambiguous and must be repaired offline instead of guessing online.
 */
export function resolveWhatsAppConversationAlias(
  jid: string,
  candidates: Iterable<string>,
): WhatsAppConversationAliasResolution {
  const canonical = canonicalizeWhatsAppConversationJid(jid);
  const existing = new Set(candidates);
  if (existing.has(canonical)) {
    return { status: 'canonical', jid: canonical, aliases: [] };
  }
  const aliases = findLegacyWhatsAppConversationAliases(canonical, existing);
  if (aliases.length === 1) {
    return { status: 'legacy', jid: aliases[0]!, aliases: [aliases[0]!] };
  }
  if (aliases.length > 1) {
    return { status: 'conflict', jid: null, aliases };
  }
  return { status: 'new', jid: canonical, aliases: [] };
}

export function whatsAppAliasRoutingSignature(
  group: WhatsAppAliasRoutingMetadata,
): string {
  return JSON.stringify({
    folder: group.folder,
    created_by: group.created_by ?? null,
    channel_account_id: group.channel_account_id ?? null,
    target_main_jid: group.target_main_jid ?? null,
    target_agent_id: group.target_agent_id ?? null,
    owner_im_id: group.owner_im_id ?? null,
    owner_claim_source: group.owner_claim_source ?? null,
    binding_mode: group.binding_mode ?? 'single_context',
    reply_policy: group.reply_policy ?? 'source_only',
    require_mention: group.require_mention === true,
    activation_mode: group.activation_mode ?? 'auto',
    audience_mode: group.audience_mode ?? 'everyone',
    sender_allowlist: [...(group.sender_allowlist ?? [])].sort(),
  });
}

/**
 * Production resolver with enough metadata to recognize aliases already made
 * equivalent by the offline repair. Identity-only callers remain conservative
 * and receive `conflict` for every multi-alias set.
 */
export function resolveWhatsAppConversationAliasFromGroups(
  jid: string,
  groups: Readonly<Record<string, WhatsAppAliasRoutingMetadata>>,
): WhatsAppConversationAliasResolution {
  const resolved = resolveWhatsAppConversationAlias(jid, Object.keys(groups));
  if (resolved.status !== 'conflict') return resolved;
  const aliases = [...resolved.aliases].sort();
  const signatures = aliases.map((alias) => {
    const group = groups[alias];
    return group ? whatsAppAliasRoutingSignature(group) : null;
  });
  if (
    signatures.length > 0 &&
    signatures[0] !== null &&
    signatures.every((signature) => signature === signatures[0])
  ) {
    return {
      status: 'legacy_equivalent',
      jid: aliases[0]!,
      aliases,
    };
  }
  return { status: 'conflict', jid: null, aliases };
}
