import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_IPC_WATCHER_FALLBACK_MS = 2000;

export interface IpcRuntimeNamespace {
  agentId?: string | null;
  taskRunId?: string | null;
}

export interface IpcWatcherErrorContext {
  phase: 'process_group' | 'fallback_scan';
  folder?: string;
}

export interface IpcWatcherManagerOptions {
  ipcBaseDir: string;
  isShuttingDown: () => boolean;
  onError?: (error: unknown, context: IpcWatcherErrorContext) => void;
  debounceMs?: number;
  fallbackMs?: number;
}

interface RuntimeWatchEntry {
  folder: string;
  watchers: fs.FSWatcher[];
  refCount: number;
}

/**
 * Event-driven watcher for every concrete IPC runtime namespace.
 *
 * Main, conversation-agent and isolated-task runners mount different roots;
 * watching only the workspace-level messages/tasks directories leaves nested
 * requests dependent on the slow full-scan fallback. Entries are reference
 * counted because provider fallback and overlapping warm turns can briefly
 * share the same namespace.
 */
export class IpcWatcherManager {
  private readonly watchers = new Map<string, RuntimeWatchEntry>();
  private readonly debounceTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private readonly processingFolders = new Set<string>();
  private readonly pendingReprocess = new Set<string>();
  private fallbackTimer: ReturnType<typeof setInterval> | null = null;
  private processGroupFn: ((folder: string) => Promise<void>) | null = null;
  private processFullFn: (() => Promise<void>) | null = null;

  constructor(private readonly options: IpcWatcherManagerOptions) {}

  bind(
    processGroup: (folder: string) => Promise<void>,
    processFull: () => Promise<void>,
  ): void {
    this.processGroupFn = processGroup;
    this.processFullFn = processFull;
  }

  private runtimeKey(folder: string, namespace: IpcRuntimeNamespace): string {
    const suffix = namespace.agentId
      ? `agent:${namespace.agentId}`
      : namespace.taskRunId
        ? `task:${namespace.taskRunId}`
        : 'main';
    return `${folder}\0${suffix}`;
  }

  private runtimeRoot(folder: string, namespace: IpcRuntimeNamespace): string {
    if (namespace.agentId && namespace.taskRunId) {
      throw new Error(
        'IPC runtime cannot be both an agent and an isolated task',
      );
    }
    const groupRoot = path.join(this.options.ipcBaseDir, folder);
    if (namespace.agentId) {
      return path.join(groupRoot, 'agents', namespace.agentId);
    }
    if (namespace.taskRunId) {
      return path.join(groupRoot, 'tasks-run', namespace.taskRunId);
    }
    return groupRoot;
  }

  /** Acquire watchers for the exact root mounted into one runner. */
  watchRuntime(folder: string, namespace: IpcRuntimeNamespace = {}): void {
    const key = this.runtimeKey(folder, namespace);
    const existing = this.watchers.get(key);
    if (existing) {
      existing.refCount += 1;
      return;
    }

    const root = this.runtimeRoot(folder, namespace);
    const runtimeWatchers: fs.FSWatcher[] = [];
    for (const dir of [path.join(root, 'messages'), path.join(root, 'tasks')]) {
      try {
        fs.mkdirSync(dir, { recursive: true });
        const watcher = fs.watch(dir, () => this.debouncedProcess(folder));
        watcher.on('error', () => {
          // The periodic full scan remains the recovery path for an invalidated
          // platform watcher. Avoid throwing from EventEmitter error handlers.
        });
        runtimeWatchers.push(watcher);
      } catch {
        // The periodic full scan remains the fallback when fs.watch is absent.
      }
    }
    this.watchers.set(key, {
      folder,
      watchers: runtimeWatchers,
      refCount: 1,
    });
    // Close the creation race: a freshly spawned child can atomically publish
    // its first request between mkdir and fs.watch registration. An immediate
    // guarded drain observes that file without waiting for fallback polling.
    this.debouncedProcess(folder);
  }

  /** Release one runtime acquisition and close its leaf watchers at zero. */
  unwatchRuntime(folder: string, namespace: IpcRuntimeNamespace = {}): void {
    const key = this.runtimeKey(folder, namespace);
    const entry = this.watchers.get(key);
    if (!entry) return;
    entry.refCount -= 1;
    if (entry.refCount > 0) return;

    for (const watcher of entry.watchers) {
      try {
        watcher.close();
      } catch {
        // Already closed by the platform.
      }
    }
    this.watchers.delete(key);
    if (!this.hasFolderWatchers(folder)) {
      const timer = this.debounceTimers.get(folder);
      if (timer) clearTimeout(timer);
      this.debounceTimers.delete(folder);
      this.pendingReprocess.delete(folder);
    }
  }

  private hasFolderWatchers(folder: string): boolean {
    for (const entry of this.watchers.values()) {
      if (entry.folder === folder) return true;
    }
    return false;
  }

  private debouncedProcess(folder: string): void {
    const existing = this.debounceTimers.get(folder);
    if (existing) clearTimeout(existing);
    this.debounceTimers.set(
      folder,
      setTimeout(() => {
        this.debounceTimers.delete(folder);
        if (this.processingFolders.has(folder)) {
          this.pendingReprocess.add(folder);
          return;
        }
        this.processingFolders.add(folder);
        this.processGroupFn?.(folder)
          .catch((error) => {
            this.options.onError?.(error, {
              phase: 'process_group',
              folder,
            });
          })
          .finally(() => {
            this.processingFolders.delete(folder);
            if (
              this.pendingReprocess.delete(folder) &&
              this.hasFolderWatchers(folder)
            ) {
              this.debouncedProcess(folder);
            }
          });
      }, this.options.debounceMs ?? 100),
    );
  }

  triggerProcess(folder: string): void {
    this.debouncedProcess(folder);
  }

  startFallback(): void {
    if (this.fallbackTimer) return;
    this.fallbackTimer = setInterval(() => {
      if (this.options.isShuttingDown()) return;
      this.processFullFn?.().catch((error) => {
        this.options.onError?.(error, { phase: 'fallback_scan' });
      });
      // Keep the recovery poll comfortably below the Runner's bounded context
      // IPC deadline. A 5s fallback paired with a 5s Runner timeout was a
      // deterministic race even after adding a final deadline read, because the
      // Host still debounces the discovered folder before processing it.
    }, this.options.fallbackMs ?? DEFAULT_IPC_WATCHER_FALLBACK_MS);
    this.fallbackTimer.unref();
  }

  closeAll(): void {
    for (const entry of this.watchers.values()) {
      for (const watcher of entry.watchers) {
        try {
          watcher.close();
        } catch {
          // Already closed by the platform.
        }
      }
    }
    this.watchers.clear();
    for (const timer of this.debounceTimers.values()) clearTimeout(timer);
    this.debounceTimers.clear();
    this.processingFolders.clear();
    this.pendingReprocess.clear();
    if (this.fallbackTimer) {
      clearInterval(this.fallbackTimer);
      this.fallbackTimer = null;
    }
  }

  /** Test/diagnostic visibility for leak assertions. */
  get activeRuntimeCount(): number {
    return this.watchers.size;
  }
}
