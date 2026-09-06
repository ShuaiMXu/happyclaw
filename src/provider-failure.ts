export const PROVIDER_FAILURE_USER_NOTICE =
  '⚠️ 当前模型服务额度已用尽或暂时不可用，本次处理已停止。请稍后重试，或联系管理员切换可用模型。';

/**
 * A liveness stall is not an account verdict, so it must not reuse the quota
 * wording. It is only surfaced after the bounded same-provider retry is spent.
 */
export const PROVIDER_LIVENESS_TIMEOUT_USER_NOTICE =
  '⚠️ 模型服务本轮长时间没有任何响应，重试后仍未恢复，本次请求未被执行。这通常是上游暂时不可用或网络中断，与账号额度无关。请稍后重新发送。';

/**
 * A reported upstream error (529/5xx). Same disposition as a stall, but the
 * upstream did answer, so the wording must not claim it went silent.
 */
export const PROVIDER_TRANSIENT_FAILURE_USER_NOTICE =
  '⚠️ 模型服务上游暂时不可用（过载或服务端错误），重试后仍未恢复，本次请求未被执行。这与账号额度无关。请稍后重新发送。';

/**
 * A configuration verdict, not a capacity one. Retrying and failing over both
 * re-send the same unserviceable model name, so the user has to act.
 */
export const PROVIDER_MODEL_CONFIG_USER_NOTICE =
  '⚠️ 当前配置的模型在该服务端不存在或不可用，本次请求未被执行。这不是额度问题，重试或切换账号都无法解决，请在「模型配置」中检查模型名称。';

/** Failure classes as reported by the agent runner. */
export type ProviderFailureClass = 'account' | 'transient' | 'config';

/** The subset of an output that determines the failure class and its notice. */
export interface ProviderFailureClassification {
  readonly providerFailureClass?: ProviderFailureClass;
  readonly providerLivenessTimeout?: boolean;
}

/**
 * Resolve the class a failure must be dispositioned as.
 *
 * Defaults to `account` when the field is absent so that an output framed by an
 * older runner keeps its historical disposition rather than silently gaining
 * the never-quarantine transient path. `providerLivenessTimeout` is honoured on
 * its own for the same reason: a batch-1 runner emits the stall flag without a
 * class, and that stall must still avoid the quarantine.
 */
export function resolveProviderFailureClass(
  output: ProviderFailureClassification,
): ProviderFailureClass {
  if (output.providerFailureClass) return output.providerFailureClass;
  return output.providerLivenessTimeout ? 'transient' : 'account';
}

/**
 * The notice for a failure that has become terminal, or undefined when the
 * caller's own notice (an upstream limit text, or the generic pool notice)
 * should stand.
 */
export function resolveTerminalProviderFailureNotice(
  output: ProviderFailureClassification,
): string | undefined {
  const failureClass = resolveProviderFailureClass(output);
  if (failureClass === 'config') return PROVIDER_MODEL_CONFIG_USER_NOTICE;
  if (failureClass !== 'transient') return undefined;
  return output.providerLivenessTimeout
    ? PROVIDER_LIVENESS_TIMEOUT_USER_NOTICE
    : PROVIDER_TRANSIENT_FAILURE_USER_NOTICE;
}

export interface ProviderFailureHealth {
  profileId: string;
  healthy: boolean;
}

export interface ProviderFailureDisposition {
  /** Another configured provider can replay the same durable input. */
  retryElsewhere: boolean;
  /** The provider pool is exhausted, so the user input must end visibly. */
  terminal: boolean;
}

/**
 * Decide whether an account/provider failure should remain a control-plane
 * retry signal or become a terminal user-visible failure.
 *
 * The failed provider must be quarantined before this function is called.
 */
export function resolveProviderFailureDisposition(
  selectedProfileId: string | null,
  health: ProviderFailureHealth[],
): ProviderFailureDisposition {
  const retryElsewhere =
    selectedProfileId !== null &&
    health.some(
      (candidate) =>
        candidate.profileId !== selectedProfileId && candidate.healthy,
    );
  return {
    retryElsewhere,
    terminal: !retryElsewhere,
  };
}

/** The identity fields a transient replay budget can be keyed on. */
export interface TransientRetryIdentity {
  readonly inputTurnId?: string;
  readonly ipcReceipts?: ReadonlyArray<{ cursor: { id: string } }>;
}

/**
 * A replay-stable identity for the input turn behind an output.
 *
 * `inputTurnId` is the IPC deliveryId for a warm turn, and that is a fresh UUID
 * on every hand-off — keying the retry budget on it would reset the budget on
 * each replay and never converge. The durable message id carried by the receipt
 * cursor survives replay, so prefer it. Cold turns already use the message id as
 * their ContainerInput.turnId, so they are stable either way.
 */
export function resolveTransientRetryKey(
  output: TransientRetryIdentity,
): string | undefined {
  return output.ipcReceipts?.[0]?.cursor?.id || output.inputTurnId;
}

/** Same-provider replay budget for one transient provider failure. */
export const DEFAULT_MAX_TRANSIENT_RETRIES = 1;
const DEFAULT_MAX_TRACKED_TRANSIENT_TURNS = 512;

/**
 * Bounded same-provider replay budget for transient provider failures — both
 * silent stalls and reported upstream errors — keyed by durable input turn.
 *
 * A transient failure judged no account, so the right answer is to run the same
 * input again rather than retire it. Each retry is a fresh runner, so the ledger
 * must live in the long-lived host process. It is what stops a permanently
 * wedged upstream from replaying one input forever.
 */
export class TransientRetryLedger {
  private readonly used = new Map<
    string,
    { attempts: number; profileId: string | null }
  >();

  constructor(
    private readonly maxRetries: number = DEFAULT_MAX_TRANSIENT_RETRIES,
    private readonly maxTracked: number = DEFAULT_MAX_TRACKED_TRANSIENT_TURNS,
  ) {}

  /**
   * @returns true when one more same-provider attempt is still allowed.
   *
   * Without a durable turn identity there is nothing to bound a replay with, so
   * this fails closed rather than risk an unbounded loop.
   */
  consume(
    inputTurnId: string | undefined,
    selectedProfileId: string | null = null,
  ): boolean {
    if (!inputTurnId) return false;
    const entry = this.used.get(inputTurnId);
    const spent = entry?.attempts ?? 0;
    if (
      spent >= this.maxRetries ||
      (entry && entry.profileId !== selectedProfileId)
    ) {
      this.used.delete(inputTurnId);
      return false;
    }
    // Turns that later succeed never come back to clear their entry, so evict
    // in insertion order instead of leaking one entry per stall.
    if (!this.used.has(inputTurnId) && this.used.size >= this.maxTracked) {
      const oldest = this.used.keys().next().value;
      if (oldest !== undefined) this.used.delete(oldest);
    }
    this.used.set(inputTurnId, {
      attempts: spent + 1,
      profileId: entry?.profileId ?? selectedProfileId,
    });
    return true;
  }

  /** Provider that owns the one authorized replay for this durable input. */
  pinnedProfileId(inputTurnId: string | undefined): string | null {
    if (!inputTurnId) return null;
    return this.used.get(inputTurnId)?.profileId ?? null;
  }

  clear(inputTurnId: string | undefined): void {
    if (inputTurnId) this.used.delete(inputTurnId);
  }

  /** Test/diagnostic hook: number of turns currently holding a spent retry. */
  get trackedTurnCount(): number {
    return this.used.size;
  }
}
