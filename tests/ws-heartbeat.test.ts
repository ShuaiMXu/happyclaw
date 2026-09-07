import { EventEmitter } from 'node:events';
import { describe, expect, test, vi } from 'vitest';
import {
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_MAX_MISSED_PONGS,
  createWebSocketHeartbeat,
  startWebSocketHeartbeat,
  type HeartbeatSocket,
} from '../src/ws-heartbeat.js';

/** 测试替身：记录 ping/terminate 次数，并能按需回 pong。 */
function fakeSocket() {
  let pongListener: (() => void) | undefined;
  const socket = {
    readyState: 1,
    ping: vi.fn(),
    terminate: vi.fn(),
    on: vi.fn((event: 'pong', listener: () => void) => {
      if (event === 'pong') pongListener = listener;
      return socket;
    }),
    /** 模拟对端回 pong */
    respond: () => pongListener?.(),
  };
  return socket;
}

type FakeSocket = ReturnType<typeof fakeSocket>;

const asSockets = (...sockets: FakeSocket[]): HeartbeatSocket[] =>
  sockets as unknown as HeartbeatSocket[];

describe('createWebSocketHeartbeat', () => {
  test('默认 30s 间隔、容忍 3 次 ping——刻意宽于 ws 库示例的 1 次', () => {
    const heartbeat = createWebSocketHeartbeat();
    expect(heartbeat.intervalMs).toBe(DEFAULT_HEARTBEAT_INTERVAL_MS);
    expect(heartbeat.intervalMs).toBe(30_000);
    // 单进程服务存在同步写盘与 GC 停顿，取 1 会把事件循环阻塞误判成死连接
    // 并踢掉全部客户端。这个下限是回归保护，不要调回 1。
    expect(heartbeat.maxMissedPongs).toBe(DEFAULT_MAX_MISSED_PONGS);
    expect(heartbeat.maxMissedPongs).toBe(3);
  });

  test('track 会登记连接并挂上 pong 监听', () => {
    const heartbeat = createWebSocketHeartbeat();
    const socket = fakeSocket();

    heartbeat.track(socket as unknown as HeartbeatSocket);

    expect(socket.on).toHaveBeenCalledWith('pong', expect.any(Function));
  });

  test('每轮对存活连接发 ping，且不终止它们', () => {
    const heartbeat = createWebSocketHeartbeat();
    const socket = fakeSocket();
    heartbeat.track(socket as unknown as HeartbeatSocket);

    const result = heartbeat.sweep(asSockets(socket));

    expect(socket.ping).toHaveBeenCalledTimes(1);
    expect(socket.terminate).not.toHaveBeenCalled();
    expect(result).toEqual({
      pinged: 1,
      terminated: 0,
      skipped: 0,
      failures: [],
    });
  });

  test('持续回 pong 的连接永远不会被终止', () => {
    const heartbeat = createWebSocketHeartbeat();
    const socket = fakeSocket();
    heartbeat.track(socket as unknown as HeartbeatSocket);

    for (let round = 0; round < 20; round++) {
      expect(heartbeat.sweep(asSockets(socket)).terminated).toBe(0);
      socket.respond();
    }

    expect(socket.terminate).not.toHaveBeenCalled();
    expect(socket.ping).toHaveBeenCalledTimes(20);
  });

  test('发出 3 次 ping 均无 pong 后，下一轮才终止', () => {
    const heartbeat = createWebSocketHeartbeat();
    const socket = fakeSocket();
    heartbeat.track(socket as unknown as HeartbeatSocket);

    for (let round = 0; round < 3; round++) {
      expect(heartbeat.sweep(asSockets(socket)).terminated).toBe(0);
      expect(socket.terminate).not.toHaveBeenCalled();
    }

    expect(heartbeat.sweep(asSockets(socket)).terminated).toBe(1);
    expect(socket.terminate).toHaveBeenCalledTimes(1);
    // 达到容忍次数后，终止轮不再浪费一次 ping。
    expect(socket.ping).toHaveBeenCalledTimes(3);
  });

  test('中途恢复 pong 会清零计数，不会累积到终止', () => {
    const heartbeat = createWebSocketHeartbeat();
    const socket = fakeSocket();
    heartbeat.track(socket as unknown as HeartbeatSocket);

    heartbeat.sweep(asSockets(socket)); // outstanding = 1
    heartbeat.sweep(asSockets(socket)); // outstanding = 2
    socket.respond(); // 事件循环恢复，pong 被处理 → 清零

    expect(heartbeat.sweep(asSockets(socket)).terminated).toBe(0);
    expect(heartbeat.sweep(asSockets(socket)).terminated).toBe(0);
    expect(socket.terminate).not.toHaveBeenCalled();
  });

  test('未经 track 的连接同样被计数，不会因缺省状态被立即终止', () => {
    const heartbeat = createWebSocketHeartbeat();
    const socket = fakeSocket();

    expect(heartbeat.sweep(asSockets(socket)).terminated).toBe(0);
    expect(socket.ping).toHaveBeenCalledTimes(1);
  });

  test('maxMissedPongs 可配置，且下限被钳制为 1', () => {
    const eager = createWebSocketHeartbeat({ maxMissedPongs: 1 });
    const socket = fakeSocket();
    eager.track(socket as unknown as HeartbeatSocket);

    expect(eager.sweep(asSockets(socket)).terminated).toBe(0);
    expect(socket.ping).toHaveBeenCalledTimes(1);
    expect(eager.sweep(asSockets(socket)).terminated).toBe(1);

    // 0 / 负数会让所有连接零次探测后立即终止，钳制到 1 是安全下限。
    expect(createWebSocketHeartbeat({ maxMissedPongs: 0 }).maxMissedPongs).toBe(
      1,
    );
    expect(
      createWebSocketHeartbeat({ maxMissedPongs: -5 }).maxMissedPongs,
    ).toBe(1);
  });

  test('单个连接 ping 抛错会被报告且不影响同一轮的其他连接', () => {
    const heartbeat = createWebSocketHeartbeat();
    const broken = fakeSocket();
    const pingError = new Error('socket already closed');
    broken.ping.mockImplementation(() => {
      throw pingError;
    });
    const healthy = fakeSocket();
    heartbeat.track(broken as unknown as HeartbeatSocket);
    heartbeat.track(healthy as unknown as HeartbeatSocket);

    const result = heartbeat.sweep(asSockets(broken, healthy));

    expect(healthy.ping).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ pinged: 1, terminated: 0, skipped: 0 });
    expect(result.failures).toEqual([{ operation: 'ping', error: pingError }]);
  });

  test('terminate 抛错会被报告且不计成功，也不影响其他连接', () => {
    const heartbeat = createWebSocketHeartbeat({ maxMissedPongs: 1 });
    const broken = fakeSocket();
    const terminateError = new Error('already destroyed');
    broken.terminate.mockImplementation(() => {
      throw terminateError;
    });
    const healthy = fakeSocket();

    heartbeat.sweep(asSockets(broken, healthy));
    const result = heartbeat.sweep(asSockets(broken, healthy));

    expect(healthy.terminate).toHaveBeenCalledTimes(1);
    expect(result.terminated).toBe(1);
    expect(result.failures).toEqual([
      { operation: 'terminate', error: terminateError },
    ]);
  });

  test('多连接独立计数：死连接被清理，活连接不受牵连', () => {
    const heartbeat = createWebSocketHeartbeat();
    const dead = fakeSocket();
    const alive = fakeSocket();
    heartbeat.track(dead as unknown as HeartbeatSocket);
    heartbeat.track(alive as unknown as HeartbeatSocket);

    for (let round = 0; round < 3; round++) {
      heartbeat.sweep(asSockets(dead, alive));
      alive.respond();
    }
    const result = heartbeat.sweep(asSockets(dead, alive));

    expect(result.terminated).toBe(1);
    expect(dead.terminate).toHaveBeenCalledTimes(1);
    expect(alive.terminate).not.toHaveBeenCalled();
  });

  test('跳过非 OPEN 和已经开始终止的连接', () => {
    const heartbeat = createWebSocketHeartbeat({ maxMissedPongs: 1 });
    const closing = fakeSocket();
    closing.readyState = 2;
    const dead = fakeSocket();

    heartbeat.sweep(asSockets(dead));
    const terminated = heartbeat.sweep(asSockets(closing, dead));
    const afterTerminate = heartbeat.sweep(asSockets(dead));

    expect(closing.ping).not.toHaveBeenCalled();
    expect(closing.terminate).not.toHaveBeenCalled();
    expect(terminated).toMatchObject({ terminated: 1, skipped: 1 });
    expect(afterTerminate).toMatchObject({ terminated: 0, skipped: 1 });
  });

  test('重复 track 只挂一个 pong listener，并重置未响应计数', () => {
    const heartbeat = createWebSocketHeartbeat({ maxMissedPongs: 1 });
    const socket = fakeSocket();

    heartbeat.track(socket as unknown as HeartbeatSocket);
    heartbeat.sweep(asSockets(socket));
    heartbeat.track(socket as unknown as HeartbeatSocket);

    expect(socket.on).toHaveBeenCalledTimes(1);
    expect(heartbeat.sweep(asSockets(socket)).terminated).toBe(0);
    expect(socket.ping).toHaveBeenCalledTimes(2);
  });

  test('调度器按 interval sweep，并在 WebSocketServer close 时清理 timer', () => {
    vi.useFakeTimers();
    try {
      const socket = fakeSocket();
      const server = Object.assign(new EventEmitter(), {
        clients: new Set(asSockets(socket)),
      });
      const heartbeat = createWebSocketHeartbeat({
        intervalMs: 100,
        maxMissedPongs: 1,
      });
      const onSweep = vi.fn();

      startWebSocketHeartbeat(server, heartbeat, onSweep);
      expect(vi.getTimerCount()).toBe(1);

      vi.advanceTimersByTime(100);
      expect(socket.ping).toHaveBeenCalledTimes(1);
      expect(onSweep).toHaveBeenCalledWith(
        expect.objectContaining({ pinged: 1, terminated: 0 }),
      );

      server.emit('close');
      expect(vi.getTimerCount()).toBe(0);

      vi.advanceTimersByTime(500);
      expect(onSweep).toHaveBeenCalledTimes(1);
      expect(socket.terminate).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
