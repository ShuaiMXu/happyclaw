/**
 * WebSocket 心跳：保活 + 死连接回收。
 *
 * 解决两个问题：
 *
 * 1) 保活。反向代理与 NAT 会掐掉空闲的 upgraded 连接（nginx proxy_read_timeout
 *    默认 60s，Cloudflare 100s，运营商 NAT 常见 30~120s）。没有心跳时前端会被
 *    动辄每分钟断开一次，反复弹出「连接中断，正在重连...」。服务端定期 ping 让
 *    连接始终有真实流量，读超时不会触发；浏览器由协议栈自动回 pong，前端无需
 *    任何改动。
 *
 * 2) 死连接回收。客户端非正常消失（合盖、切网、进程被杀）时 TCP 半开，'close'
 *    永不触发，连接表条目与终端会话会一直泄漏，广播持续写入黑洞。只有 ping/pong
 *    探测能发现这种连接。
 *
 * 关于 maxMissedPongs 的取值：代价高度不对称。误杀活连接会让用户看到
 * 「连接中断，正在重连...」——正是本心跳要消除的现象；而晚回收死连接只是多留
 * 一个条目和几 KB 无效广播。主服务是单进程，存在同步写盘（如文件上传）与 GC
 * 停顿，事件循环被阻塞时 pong 帧虽已到达却来不及处理，取 1（ws 库 README 示例
 * 的经典写法）会把这种停顿误判成死连接并踢掉全部客户端。因此默认取 3。
 */

/** 心跳只需要这些能力，用结构类型以便测试替身注入。 */
export interface HeartbeatSocket {
  /** ws.OPEN === 1；测试替身可省略，此时按可用连接处理。 */
  readonly readyState?: number;
  ping(): void;
  terminate(): void;
  on(event: 'pong', listener: () => void): unknown;
}

export const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
export const DEFAULT_MAX_MISSED_PONGS = 3;

export interface HeartbeatOptions {
  intervalMs?: number;
  /** 发出多少次 ping 仍收不到 pong 后判定连接已死。必须 >= 1。 */
  maxMissedPongs?: number;
}

export type HeartbeatOperation = 'ping' | 'terminate';

export interface HeartbeatOperationFailure {
  readonly operation: HeartbeatOperation;
  readonly error: unknown;
}

export interface HeartbeatSweepResult {
  /** 本轮成功调用 ping 的连接数。 */
  readonly pinged: number;
  /** 本轮成功调用 terminate 的连接数。 */
  readonly terminated: number;
  /** 已处于 CONNECTING/CLOSING/CLOSED 或已开始终止，因而跳过的连接数。 */
  readonly skipped: number;
  /** 单连接操作失败；调用方负责记录，失败不会阻断同一轮的其他连接。 */
  readonly failures: readonly HeartbeatOperationFailure[];
}

export interface WebSocketHeartbeat {
  readonly intervalMs: number;
  readonly maxMissedPongs: number;
  /** 登记一条新连接，并挂上 pong 监听。 */
  track(socket: HeartbeatSocket): void;
  /** 执行一轮探测，返回成功计数与可观测的逐操作失败。 */
  sweep(sockets: Iterable<HeartbeatSocket>): HeartbeatSweepResult;
}

/** WebSocketServer 心跳调度所需的最小结构。 */
export interface HeartbeatSocketServer {
  readonly clients: Iterable<HeartbeatSocket>;
  once(event: 'close', listener: () => void): unknown;
  off(event: 'close', listener: () => void): unknown;
}

export function createWebSocketHeartbeat(
  options: HeartbeatOptions = {},
): WebSocketHeartbeat {
  const intervalMs = options.intervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const maxMissedPongs = Math.max(
    1,
    options.maxMissedPongs ?? DEFAULT_MAX_MISSED_PONGS,
  );
  // WeakMap：连接被回收后条目自动消失，不会成为新的泄漏点。
  const missedPongs = new WeakMap<HeartbeatSocket, number>();
  // track 可能被上层重复调用；只挂一个 pong listener，避免监听器随重连路径累积。
  const trackedSockets = new WeakSet<HeartbeatSocket>();
  // terminate 成功后到 'close' 事件之间仍可能短暂留在 wss.clients，避免重复终止。
  const terminatingSockets = new WeakSet<HeartbeatSocket>();

  return {
    intervalMs,
    maxMissedPongs,

    track(socket) {
      missedPongs.set(socket, 0);
      if (trackedSockets.has(socket)) return;
      trackedSockets.add(socket);
      socket.on('pong', () => missedPongs.set(socket, 0));
    },

    sweep(sockets) {
      let terminated = 0;
      let pinged = 0;
      let skipped = 0;
      const failures: HeartbeatOperationFailure[] = [];

      for (const socket of sockets) {
        // WebSocket.OPEN === 1。connection 事件交付的连接均为 OPEN；显式跳过
        // CONNECTING/CLOSING/CLOSED，避免 close 事件尚未从 clients 移除时误报失败。
        if (
          (socket.readyState !== undefined && socket.readyState !== 1) ||
          terminatingSockets.has(socket)
        ) {
          skipped += 1;
          continue;
        }

        const missed = missedPongs.get(socket) ?? 0;
        if (missed >= maxMissedPongs) {
          // terminate() 会触发 'close'，由调用方既有的 close handler 完成
          // 连接表与终端会话清理。
          try {
            socket.terminate();
            terminatingSockets.add(socket);
            terminated += 1;
          } catch (error) {
            failures.push({ operation: 'terminate', error });
          }
          continue;
        }

        // 先记录 outstanding ping，再调用 ping：如果测试替身/实现同步触发 pong，
        // pong listener 的清零不能被随后一次 set 覆盖。
        missedPongs.set(socket, missed + 1);
        try {
          socket.ping();
          pinged += 1;
        } catch (error) {
          failures.push({ operation: 'ping', error });
        }
      }

      return { pinged, terminated, skipped, failures };
    },
  };
}

/**
 * 启动心跳调度，并在 WebSocketServer 关闭时同步清除 interval。
 * 返回的 stop 可用于提前停止；重复调用安全。
 */
export function startWebSocketHeartbeat(
  server: HeartbeatSocketServer,
  heartbeat: WebSocketHeartbeat,
  onSweep: (result: HeartbeatSweepResult) => void,
): () => void {
  let stopped = false;
  const timer = setInterval(() => {
    onSweep(heartbeat.sweep(server.clients));
  }, heartbeat.intervalMs);

  // 心跳不能阻止 Node 进程自然退出。
  timer.unref?.();

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    server.off('close', stop);
  };

  server.once('close', stop);
  return stop;
}
