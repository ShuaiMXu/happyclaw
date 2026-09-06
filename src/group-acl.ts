import { getJidsByFolder, getRegisteredGroup } from './db.js';
import type { RegisteredGroup, UserRole } from './types.js';

/** Owner-scoped workspace and IM visibility policy. */
export function canAccessGroup(
  user: { id: string; role: UserRole },
  group: RegisteredGroup & { jid: string },
): boolean {
  if (group.is_home) return group.created_by === user.id;
  if (!group.jid.startsWith('web:')) {
    if (group.created_by === user.id) return true;
    if (group.created_by) return false;
    const siblingJids = getJidsByFolder(group.folder);
    for (const jid of siblingJids) {
      if (jid === group.jid) continue;
      const sibling = getRegisteredGroup(jid);
      if (sibling?.is_home && sibling.created_by) {
        return sibling.created_by === user.id;
      }
    }
    return false;
  }
  return group.created_by === user.id;
}

/** Owner-scoped workspace and IM mutation policy. */
export function canModifyGroup(
  user: { id: string; role: UserRole },
  group: RegisteredGroup & { jid: string },
): boolean {
  if (group.is_home) return group.created_by === user.id;
  if (!group.jid.startsWith('web:')) {
    if (group.created_by) return group.created_by === user.id;
    const siblingJids = getJidsByFolder(group.folder);
    for (const jid of siblingJids) {
      if (jid === group.jid) continue;
      const sibling = getRegisteredGroup(jid);
      if (sibling?.is_home && sibling.created_by) {
        return sibling.created_by === user.id;
      }
    }
    return false;
  }
  return group.created_by === user.id;
}

export function canDeleteGroup(
  user: { id: string; role: UserRole },
  group: RegisteredGroup & { jid: string },
): boolean {
  if (group.is_home) return false;
  return canModifyGroup(user, group);
}
