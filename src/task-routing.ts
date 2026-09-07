/**
 * Pure helpers used by the scheduled-task IM routing pipeline.
 *
 * Extracted from src/index.ts so unit tests can import them without booting
 * the main service (src/index.ts runs main() at module load). All external
 * lookups are injected via `deps`; this file has no side effects.
 */

/**
 * Scan a message list backwards and return the most recent non-empty `task_id`,
 * or undefined if none. Used to propagate the triggering task's id from
 * getMessagesSince() output into agent-runner via ContainerInput.messageTaskId.
 *
 * Mixed-batch semantics ("later wins"): when a batch contains both normal user
 * messages and task-prompt rows, the whole batch is attributed to the most
 * recent task_id in the batch. The batch is collapsed into a single agent
 * turn and cannot be split back apart; we accept a slightly conservative
 * misattribution (a user-initiated send may be routed through the task's
 * IM broadcast path) over losing task attribution entirely (which would cause
 * the task's configured notify_channels / chat_jid to be silently ignored).
 * See tests/container-input-taskid.test.ts for the locked-in cases.
 */
export function extractLastTaskId(
  messages: ReadonlyArray<{ task_id?: string | null }>,
): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const candidate = messages[i]?.task_id;
    if (candidate) return candidate;
  }
  return undefined;
}

/**
 * Host-verified durable occurrence fields consumed by the IPC router.
 *
 * Routing must never be derived from the runner-supplied task id or the live
 * task definition. A task may be edited while an occurrence is running, and
 * an IPC writer is not a trusted authority for choosing another task's
 * recipients. The durable run is correlated by the host and its definition
 * snapshot is immutable for the lifetime of the occurrence.
 */
export interface TaskRunForRouting {
  task_id: string;
  definition_snapshot: {
    group_folder: string;
    notify_channels?: string[] | null;
    chat_jid?: string | null;
    delivery_route_jid?: string | null;
  };
}

/**
 * Output of resolveTaskRoutingDecision. Describes how the IPC consumer should
 * route a scheduled-task output to IM channels.
 *
 * - `mode: 'none'`: not a task message; caller falls through to regular routing.
 * - `mode: 'direct'`: task has a configured chat_jid; caller sends to it
 *   directly (unless it was already sent via data.chatJid / ipcImRoute).
 * - `mode: 'broadcast'`: no direct chat_jid; caller fans out to the owner's
 *   connected IM channels, filtered by `notifyChannels` if present.
 */
export type TaskRoutingDecision =
  | { mode: 'none' }
  | {
      mode: 'direct';
      /** The IM JID the task is configured to reply into. */
      taskChatJid: string;
      /** notify_channels from the task record, forwarded for parity with broadcast branch. */
      notifyChannels: string[] | null | undefined;
      /** Echoed for logging / debugging. */
      effectiveTaskId: string;
    }
  | {
      mode: 'broadcast';
      notifyChannels: string[] | null | undefined;
      /** undefined when neither data.taskId nor ipcTaskId was available. */
      effectiveTaskId: string | undefined;
    };

export interface ResolveTaskRoutingDeps {
  /** Should mirror src/im-channel.ts#getChannelType: non-null iff the jid belongs to an IM channel. */
  getChannelType: (jid: string) => string | null;
}

/**
 * Pure decision function capturing the "scheduled task output" branch of the
 * IPC consumer in src/index.ts (message + image variants). Separated out so
 * unit tests can exercise each codepath (`mode: 'none' | 'direct' | 'broadcast'`)
 * without booting the main service.
 *
 * Contract (locked by tests/task-routing-decision.test.ts):
 * - A host-verified durable run, matching source workspace, and owner
 *   attribution are all required for task routing.
 * - Delivery settings come only from the run's immutable definition snapshot.
 * - Direct-mode requires the frozen `delivery_route_jid`/`chat_jid` to be a valid IM JID
 *   (getChannelType non-null). A null/web/unknown chat_jid falls back to
 *   broadcast so tasks without a configured IM target still fan out.
 */
export function resolveTaskRoutingDecision(
  run: TaskRunForRouting | null | undefined,
  sourceFolder: string,
  hasCreatedBy: boolean,
  deps: ResolveTaskRoutingDeps,
): TaskRoutingDecision {
  if (
    !run ||
    !hasCreatedBy ||
    run.definition_snapshot.group_folder !== sourceFolder
  ) {
    return { mode: 'none' };
  }

  const effectiveTaskId = run.task_id;
  const notifyChannels = run.definition_snapshot.notify_channels;
  const taskChatJid =
    run.definition_snapshot.delivery_route_jid ??
    run.definition_snapshot.chat_jid;

  if (taskChatJid && deps.getChannelType(taskChatJid)) {
    return {
      mode: 'direct',
      taskChatJid,
      notifyChannels,
      effectiveTaskId,
    };
  }

  return {
    mode: 'broadcast',
    notifyChannels,
    effectiveTaskId,
  };
}

export interface BroadcastToOwnerIMChannelsDeps {
  getConnectedChannelTypes: (userId: string) => string[];
  getGroupsByOwner: (userId: string) => Array<{
    jid: string;
    folder: string;
    /**
     * Set by ImBindingDialog when an IM group is explicitly bound to a
     * non-home workspace. Overrides the group's own `folder` for routing
     * purposes — see resolveImGroupEffectiveFolder.
     */
    target_main_jid?: string | null;
  }>;
  getChannelType: (jid: string) => string | null;
  /**
   * Resolve a `web:xxx` JID to the workspace folder it points to. Used to
   * follow `target_main_jid` bindings when matching broadcast targets.
   * Return null for unknown / unresolvable JIDs so the caller can fall
   * back to the IM group's own folder.
   */
  resolveJidFolder: (jid: string) => string | null;
}

/**
 * Resolve every physical target required by one frozen task occurrence.
 *
 * A configured delivery route is always included. Explicit notify channels
 * are additional recipients, not an alternative to the bound route. When no
 * direct route exists, legacy null/undefined selection keeps the historical
 * all-connected-channel fan-out; an explicit list is a strict contract and
 * unresolved channel types are returned to the durable receipt caller.
 */
export function resolveTaskNotificationTargets(
  userId: string,
  sourceFolder: string,
  decision: TaskRoutingDecision,
  deps: BroadcastToOwnerIMChannelsDeps,
): { targetJids: string[]; unavailableChannels: string[] } {
  if (decision.mode === 'none') {
    return { targetJids: [], unavailableChannels: [] };
  }

  const targetJids: string[] = [];
  const alreadySelected = new Set<string>();
  if (decision.mode === 'direct') {
    targetJids.push(decision.taskChatJid);
    alreadySelected.add(decision.taskChatJid);
  }

  const shouldFanOut =
    decision.mode === 'broadcast' ||
    (Array.isArray(decision.notifyChannels) &&
      decision.notifyChannels.length > 0);
  const unavailableChannels = shouldFanOut
    ? broadcastToOwnerIMChannels(
        userId,
        sourceFolder,
        alreadySelected,
        (jid) => targetJids.push(jid),
        decision.notifyChannels,
        deps,
      )
    : [];
  return { targetJids, unavailableChannels };
}

/**
 * Compute the workspace folder an IM group should be considered to "belong"
 * to when the scheduled-task broadcaster is looking for recipients.
 *
 * There are TWO ways a user can bind an IM group to a workspace:
 *
 * 1. **Shared folder** — the IM group's own `folder` matches the workspace's
 *    folder. Used for home workspaces (auto-registered via onNewChat) and
 *    some migration flows.
 * 2. **target_main_jid** — the IM group keeps its own `folder` (usually the
 *    home folder) but stores a pointer to the intended workspace via
 *    `target_main_jid`. Used by the ImBindingDialog UI.
 *
 * Both must be respected by the broadcast matcher; otherwise scheduled
 * tasks created in non-home workspaces will silently fail to reach
 * their bound IM groups when the binding is the (2) kind.
 *
 * Precedence: `target_main_jid` wins when present and resolvable, matching
 * the semantics used by `resolveOwnerHomeFolder` in src/index.ts.
 */
export function resolveImGroupEffectiveFolder(
  group: { folder: string; target_main_jid?: string | null },
  resolveJidFolder: (jid: string) => string | null,
): string {
  if (group.target_main_jid) {
    const resolved = resolveJidFolder(group.target_main_jid);
    if (resolved) return resolved;
  }
  return group.folder;
}

/**
 * Pick the folder used to fan out a scheduled-task message to the owner's IM
 * channels. This is a *deliberate decision* between two candidates — the
 * emitting workspace's own folder (`sourceFolder`), or the owner's home
 * workspace folder (`ownerHomeFolder`) — and the answer is always
 * `sourceFolder`.
 *
 * This encodes fix F: pre-fix code returned `ownerHomeFolder`, which broke
 * non-home workspaces bound to their own IM groups (replies were routed to
 * the home workspace's IM bindings instead of the emitting workspace's).
 *
 * Both candidates are accepted as parameters so the caller can't silently
 * revert to ownerHome by choosing a different expression — any regression
 * shows up as a functional change to this helper (locked by tests), not an
 * innocent-looking one-line edit at the call site.
 *
 * The `ownerHomeFolder` parameter is intentionally unused in the return
 * value; it exists purely as a "witness" that the caller considered both
 * options and chose sourceFolder. See tests/task-routing-decision.test.ts
 * for the locked contract.
 */
export function resolveBroadcastFolder(
  sourceFolder: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _ownerHomeFolder: string | null | undefined,
): string {
  return sourceFolder;
}

/**
 * Broadcast a message to all connected IM channels of a user that haven't
 * already received it. Used by scheduled tasks to fan out to all IM channels.
 * `sourceFolder` filters to groups whose folder matches the emitting workspace,
 * so IM bindings on unrelated workspaces are ignored.
 */
export function broadcastToOwnerIMChannels(
  userId: string,
  sourceFolder: string,
  alreadySentJids: Set<string>,
  sendFn: (jid: string) => void,
  notifyChannels: string[] | null | undefined,
  deps: BroadcastToOwnerIMChannelsDeps,
): string[] {
  const sentChannelTypes = new Set<string>();
  for (const jid of alreadySentJids) {
    const ct = deps.getChannelType(jid);
    if (ct) sentChannelTypes.add(ct);
  }
  const connectedTypes = deps.getConnectedChannelTypes(userId);
  const ownerGroups = deps.getGroupsByOwner(userId);
  for (const channelType of connectedTypes) {
    if (sentChannelTypes.has(channelType)) continue;
    if (notifyChannels && !notifyChannels.includes(channelType)) continue;
    const target = ownerGroups.find((g) => {
      if (deps.getChannelType(g.jid) !== channelType) return false;
      // Match on the group's *effective* routing folder so both "shared
      // folder" and "target_main_jid" bindings reach this broadcaster.
      // Without this, ImBindingDialog-bound IM groups (whose own folder
      // stays at 'main') silently miss scheduled-task broadcasts from
      // non-home workspaces.
      const effectiveFolder = resolveImGroupEffectiveFolder(
        g,
        deps.resolveJidFolder,
      );
      return effectiveFolder === sourceFolder;
    });
    if (target) {
      sendFn(target.jid);
      sentChannelTypes.add(channelType);
    }
  }
  // An explicit notification selection is a delivery contract, not a best-
  // effort hint. Return requested channel types that could not be resolved to
  // a connected binding so the caller can persist a truthful failed receipt.
  // Legacy fan-out (`null` / `undefined`) keeps its best-effort semantics.
  return notifyChannels
    ? [...new Set(notifyChannels)].filter(
        (channelType) => !sentChannelTypes.has(channelType),
      )
    : [];
}
