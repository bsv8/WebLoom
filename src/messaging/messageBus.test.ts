// packages/runtime/src/messageBus.test.ts
// MessageBus 行为单测。
//
// 关键不变量（阶段 2）：
//   - publish 同步调用 subscriber；不等待 async handler。
//   - subscribe 取消订阅后 handler 立即停止接收。
//   - handler 抛错不影响其它 handler。
//   - handler 内取消订阅自己：使用快照迭代，迭代集合不被修改。
//   - request 返回结果；handler 抛错时 promise reject。
//   - dispatch 把消息真正投递到 actor mailbox 并执行 handler（阶段 1 no-op 已修）。
//   - request timeout 触发时 abort 内部 signal + 写 lastError + canceled 计数。
//   - snapshot.inFlight 在异步 request 期间 > 0；完成后回到 0。

import { describe, expect, it } from "vitest";
import { createMessageBus } from "./messageBus.js";

describe("MessageBus.publish/subscribe", () => {
  it("invokes subscribers synchronously in registration order", () => {
    const bus = createMessageBus();
    const order: string[] = [];
    bus.subscribe("test.order", (p) => order.push(`a:${(p as { v: number }).v}`));
    bus.subscribe("test.order", (p) => order.push(`b:${(p as { v: number }).v}`));
    bus.publish("test.order", { v: 1 });
    expect(order).toEqual(["a:1", "b:1"]);
  });

  it("does not await async handlers", async () => {
    const bus = createMessageBus();
    let resolved = false;
    bus.subscribe("test.async", () => {
      void Promise.resolve().then(() => {
        resolved = true;
      });
    });
    bus.publish("test.async", { v: 1 });
    // 同步 publish 不等待；resolved 仍是 false。
    expect(resolved).toBe(false);
    // 等一个 microtask 让 promise 推进。
    await Promise.resolve();
    expect(resolved).toBe(true);
  });

  it("returns the message id", () => {
    const bus = createMessageBus();
    const id = bus.publish("test.id", { v: 1 });
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
  });

  it("does not invoke unsubscribed handler", () => {
    const bus = createMessageBus();
    let calls = 0;
    const off = bus.subscribe("test.unsub", () => {
      calls += 1;
    });
    bus.publish("test.unsub", { v: 1 });
    expect(calls).toBe(1);
    off();
    bus.publish("test.unsub", { v: 2 });
    expect(calls).toBe(1);
  });

  it("handler throwing does not stop other handlers", () => {
    const bus = createMessageBus();
    let second = 0;
    bus.subscribe("test.throw", () => {
      throw new Error("boom");
    });
    bus.subscribe("test.throw", () => {
      second += 1;
    });
    bus.publish("test.throw", { v: 1 });
    expect(second).toBe(1);
    expect(bus.snapshot().lastError).toContain("boom");
  });

  it("handler unsubscribing itself during publish does not break iteration", () => {
    // 关键修复：第二次 publish 必须清空 order，避免和第一次的累积混在一起。
    const bus = createMessageBus();
    const order: string[] = [];
    bus.subscribe("test.self-unsub", () => {
      order.push("a");
    });
    let off: () => void = () => undefined;
    bus.subscribe("test.self-unsub", () => {
      order.push("b");
      off();
    });
    bus.subscribe("test.self-unsub", () => {
      order.push("c");
    });
    off = bus.subscribe("test.self-unsub", () => {
      order.push("d");
    });
    // 第一次 publish：a / b / c / d 都会被调用（快照迭代，b 取消的 d 是后续）。
    bus.publish("test.self-unsub", { v: 1 });
    expect(order).toContain("a");
    expect(order).toContain("b");
    expect(order).toContain("c");
    expect(order).toContain("d");
    // 第二次 publish：d 已被 b 取消，必须重新清空 order 避免历史污染。
    order.length = 0;
    bus.publish("test.self-unsub", { v: 2 });
    expect(order).toContain("a");
    expect(order).toContain("b");
    expect(order).toContain("c");
    expect(order).not.toContain("d");
  });
});

describe("MessageBus.request", () => {
  it("resolves with the handler return value", async () => {
    const bus = createMessageBus();
    bus.handle("rpc.add", (m) => {
      const p = m.payload as { a: number; b: number };
      return p.a + p.b;
    }, { target: "math" });
    const r = await bus.request<{ a: number; b: number }, number>("rpc.add", { a: 1, b: 2 }, { target: "math" });
    expect(r).toBe(3);
  });

  it("rejects when handler throws", async () => {
    const bus = createMessageBus();
    bus.handle("rpc.fail", () => {
      throw new Error("nope");
    }, { target: "math" });
    await expect(
      bus.request("rpc.fail", { v: 1 }, { target: "math" })
    ).rejects.toThrow(/nope/);
  });

  it("rejects when no handler is registered", async () => {
    const bus = createMessageBus();
    await expect(
      bus.request("rpc.missing", { v: 1 }, { target: "math" })
    ).rejects.toThrow(/No handler/);
  });

  it("handler receives message.signal as MessageBus-managed abort signal", async () => {
    const bus = createMessageBus();
    let receivedSignal: AbortSignal | undefined;
    bus.handle("rpc.signal", (m) => {
      receivedSignal = m.signal;
      return 1;
    }, { target: "math" });
    await bus.request<unknown, number>("rpc.signal", { v: 1 }, { target: "math" });
    expect(receivedSignal).toBeDefined();
    expect(receivedSignal?.aborted).toBe(false);
  });
});

describe("MessageBus.dispatch", () => {
  it("actually executes the routed handler (regression for stage 1 no-op)", async () => {
    const bus = createMessageBus();
    let received: unknown = undefined;
    bus.handle("cmd.echo", (m) => {
      received = m.payload;
      return m.payload;
    }, { target: "echo" });
    const id = bus.dispatch("cmd.echo", { hello: "world" }, { target: "echo" });
    expect(typeof id).toBe("string");
    // 等待 microtask 让 pump 跑完。
    await Promise.resolve();
    await Promise.resolve();
    expect(received).toEqual({ hello: "world" });
  });

  it("returns a string id and does not throw when handler completes", async () => {
    const bus = createMessageBus();
    bus.handle("cmd.ok", () => undefined, { target: "x" });
    const id = bus.dispatch("cmd.ok", { v: 1 }, { target: "x" });
    expect(typeof id).toBe("string");
    await Promise.resolve();
    await Promise.resolve();
    expect(bus.snapshot().failed).toBe(0);
  });

  it("handler error is written to lastError + failed counter, not thrown to caller", async () => {
    const bus = createMessageBus();
    bus.handle("cmd.boom", () => {
      throw new Error("kaboom");
    }, { target: "x" });
    // dispatch 同步返回 id；handler 抛错不冒泡。
    expect(() => bus.dispatch("cmd.boom", { v: 1 }, { target: "x" })).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
    expect(bus.snapshot().lastError).toContain("kaboom");
    expect(bus.snapshot().failed).toBe(1);
  });

  it("missing handler writes lastError and counts as failed", async () => {
    const bus = createMessageBus();
    bus.dispatch("cmd.missing", { v: 1 }, { target: "nowhere" });
    expect(bus.snapshot().lastError).toContain("No handler");
    expect(bus.snapshot().failed).toBe(1);
  });
});

describe("MessageBus.request timeout", () => {
  it("aborts message.signal and rejects promise after timeoutMs", async () => {
    const bus = createMessageBus();
    let receivedSignal: AbortSignal | undefined;
    bus.handle("rpc.slow", (m) => {
      receivedSignal = m.signal;
      return new Promise(() => undefined); // 永远 pending
    }, { target: "slow" });
    const p = bus.request("rpc.slow", { v: 1 }, { target: "slow", timeoutMs: 50 });
    await expect(p).rejects.toThrow(/timeout/);
    // 内部 signal 已被 abort，handler 也应能感知。
    expect(receivedSignal?.aborted).toBe(true);
    const snap = bus.snapshot();
    // 走 canceled 路径（signal abort 优先于 failed）。
    expect(snap.canceled + snap.failed).toBeGreaterThanOrEqual(1);
  });

  it("upstream signal abort cancels queued message", async () => {
    const bus = createMessageBus();
    let receivedSignal: AbortSignal | undefined;
    bus.handle("rpc.queueable", (m) => {
      receivedSignal = m.signal;
      return new Promise(() => undefined);
    }, { target: "queueable" });
    const ctl = new AbortController();
    const p = bus.request("rpc.queueable", { v: 1 }, { target: "queueable", signal: ctl.signal });
    // 关键：handler 是 async-pending，必须在 abort 前让它跑到 inFlight；
    // 多个 microtask 让 mailbox 进入"被 pump 选中"状态。
    await Promise.resolve();
    await Promise.resolve();
    expect(bus.snapshot().inFlight).toBe(1);
    ctl.abort(new Error("caller-aborted"));
    await expect(p).rejects.toThrow(/caller-aborted/);
    // 内部 signal 也应被 abort。
    expect(receivedSignal?.aborted).toBe(true);
  });
});

describe("MessageBus.snapshot", () => {
  it("emits initial snapshot on subscribe", () => {
    const bus = createMessageBus();
    bus.publish("test.snapshot", { v: 1 });
    let received: { total: number } | undefined;
    bus.onSnapshot((s) => {
      received = s;
    });
    expect(received).toBeDefined();
    expect(received!.total).toBeGreaterThanOrEqual(1);
  });

  it("inFlight=0 for synchronous publish", () => {
    const bus = createMessageBus();
    bus.subscribe("test.sync", () => undefined);
    bus.publish("test.sync", { v: 1 });
    expect(bus.snapshot().inFlight).toBe(0);
  });

  it("inFlight>0 during async request and returns to 0 after resolve", async () => {
    const bus = createMessageBus();
    let resolveHandler: (v: number) => void = () => undefined;
    bus.handle("rpc.inflight", () => new Promise<number>((r) => {
      resolveHandler = r;
    }), { target: "inflight" });
    const p = bus.request("rpc.inflight", { v: 1 }, { target: "inflight" });
    // 让 pump 把 entry 移入 inFlight 状态。
    await Promise.resolve();
    await Promise.resolve();
    expect(bus.snapshot().inFlight).toBe(1);
    resolveHandler(42);
    const r = await p;
    expect(r).toBe(42);
    // 让 pump 跑完 finally 收尾。
    await Promise.resolve();
    await Promise.resolve();
    expect(bus.snapshot().inFlight).toBe(0);
    expect(bus.snapshot().completed).toBe(1);
  });

  it("completed / failed / canceled counters move on different paths", async () => {
    const bus = createMessageBus();
    // 1. 完成路径
    bus.handle("rpc.ok", () => 1, { target: "counter" });
    await bus.request("rpc.ok", { v: 1 }, { target: "counter" });
    expect(bus.snapshot().completed).toBe(1);

    // 2. 失败路径（handler throw）
    bus.handle("rpc.bad", () => {
      throw new Error("nope");
    }, { target: "counter" });
    await expect(bus.request("rpc.bad", { v: 1 }, { target: "counter" })).rejects.toThrow();
    expect(bus.snapshot().failed).toBe(1);

    // 3. 取消路径（upstream abort）
    bus.handle("rpc.slow2", () => new Promise(() => undefined), { target: "counter" });
    const ctl = new AbortController();
    const p = bus.request("rpc.slow2", { v: 1 }, { target: "counter", signal: ctl.signal });
    ctl.abort();
    await expect(p).rejects.toThrow();
    expect(bus.snapshot().canceled).toBe(1);
  });
});

describe("MessageBus.target concurrency & cancellation", () => {
  // 设计缘由：
  //   - 默认 concurrency=1：同 target handler 严格串行。
  //   - 显式 concurrency=N：同 target 多 handler 并行，N 必须一致。
  //   - 取消路径 settle-once：超时 / abort 后 inFlight 立即归 0，
  //     handler 晚到的 resolve/reject 不再重复计数。
  //   - 排队中的消息被 cancel 后 handler 不应被调用。

  /**
   * 等到 MessageBus 既无 inFlight 也无 queued 消息。setTimeout(0) 比
   * await Promise.resolve() 更稳定——它强制 macrotask 边界前先清空
   * 所有 microtask，避免依赖具体 microtask 数量。
   */
  async function waitForIdle(bus: ReturnType<typeof createMessageBus>) {
    for (let i = 0; i < 50; i += 1) {
      const snap = bus.snapshot();
      if (snap.inFlight === 0 && snap.queued === 0) return;
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  it("same target two async handlers run strictly serial by default", async () => {
    const bus = createMessageBus();
    let running = 0;
    let maxRunning = 0;
    const deferreds: Array<() => void> = [];
    bus.handle("cmd.work", async () => {
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      let resolve: () => void = () => undefined;
      const promise = new Promise<void>((r) => {
        resolve = r;
      });
      deferreds.push(resolve);
      await promise;
      running -= 1;
    }, { target: "worker" });
    const p1 = bus.request("cmd.work", { v: 1 }, { target: "worker" });
    const p2 = bus.request("cmd.work", { v: 2 }, { target: "worker" });
    // 让 pump 把 entry 1 拉入 inFlight。
    await new Promise((r) => setTimeout(r, 0));
    expect(bus.snapshot().inFlight).toBe(1);
    expect(maxRunning).toBe(1);
    // 释放 entry 1；pump 才会 pick entry 2。
    deferreds[0]!();
    await new Promise((r) => setTimeout(r, 0));
    // entry 1 已完成，entry 2 已 in-flight。
    expect(bus.snapshot().inFlight).toBe(1);
    expect(maxRunning).toBe(1);
    // 释放 entry 2；等所有 promise resolve。
    deferreds[1]!();
    await Promise.all([p1, p2]);
    await waitForIdle(bus);
    expect(maxRunning).toBe(1);
    expect(bus.snapshot().inFlight).toBe(0);
  });

  it("different targets run in parallel", async () => {
    const bus = createMessageBus();
    let running = 0;
    let maxRunning = 0;
    const deferreds: Array<() => void> = [];
    for (const t of ["alpha", "beta"]) {
      bus.handle(`cmd.t.${t}`, async () => {
        running += 1;
        maxRunning = Math.max(maxRunning, running);
        let resolve: () => void = () => undefined;
        const promise = new Promise<void>((r) => {
          resolve = r;
        });
        deferreds.push(resolve);
        await promise;
        running -= 1;
      }, { target: t });
    }
    const p1 = bus.request("cmd.t.alpha", {}, { target: "alpha" });
    const p2 = bus.request("cmd.t.beta", {}, { target: "beta" });
    await new Promise((r) => setTimeout(r, 0));
    expect(bus.snapshot().inFlight).toBe(2);
    expect(maxRunning).toBe(2);
    deferreds[0]!();
    deferreds[1]!();
    await Promise.all([p1, p2]);
    await waitForIdle(bus);
    expect(bus.snapshot().inFlight).toBe(0);
  });

  it("explicit concurrency on a target raises on conflict", () => {
    const bus = createMessageBus();
    bus.handle("cmd.x", () => 1, { target: "shared", concurrency: 4 });
    expect(() =>
      bus.handle("cmd.y", () => 1, { target: "shared", concurrency: 8 })
    ).toThrow(/Conflicting concurrency for target "shared"/);
  });

  it("explicit concurrency on a target allows same value for multiple types", async () => {
    const bus = createMessageBus();
    let running = 0;
    let maxRunning = 0;
    const aReleases: Array<() => void> = [];
    const bReleases: Array<() => void> = [];
    bus.handle("cmd.a", async () => {
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      await new Promise<void>((r) => aReleases.push(r));
      running -= 1;
    }, { target: "fanout", concurrency: 4 });
    bus.handle("cmd.b", async () => {
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      await new Promise<void>((r) => bReleases.push(r));
      running -= 1;
    }, { target: "fanout", concurrency: 4 });
    const p1 = bus.request("cmd.a", {}, { target: "fanout" });
    const p2 = bus.request("cmd.b", {}, { target: "fanout" });
    await new Promise((r) => setTimeout(r, 0));
    // 两个 handler 同时 in-flight。
    expect(bus.snapshot().inFlight).toBe(2);
    expect(maxRunning).toBe(2);
    aReleases[0]!();
    bReleases[0]!();
    await Promise.all([p1, p2]);
    await waitForIdle(bus);
  });

  it("inFlight returns to 0 immediately on timeout", async () => {
    const bus = createMessageBus();
    bus.handle("rpc.slow", () => new Promise(() => undefined), { target: "slow" });
    const p = bus.request("rpc.slow", { v: 1 }, { target: "slow", timeoutMs: 20 });
    await expect(p).rejects.toThrow(/timeout/);
    await waitForIdle(bus);
    expect(bus.snapshot().inFlight).toBe(0);
  });

  it("timeout message counts as canceled exactly once", async () => {
    const bus = createMessageBus();
    bus.handle("rpc.slow", () => new Promise(() => undefined), { target: "slow" });
    const p = bus.request("rpc.slow", { v: 1 }, { target: "slow", timeoutMs: 20 });
    await expect(p).rejects.toThrow(/timeout/);
    await waitForIdle(bus);
    const snap = bus.snapshot();
    expect(snap.canceled).toBe(1);
    expect(snap.failed).toBe(0);
  });

  it("handler resolving after timeout does not increment completed", async () => {
    const bus = createMessageBus();
    let resolveHandler: (v: number) => void = () => undefined;
    bus.handle("rpc.slow", () => new Promise<number>((r) => {
      resolveHandler = r;
    }), { target: "slow" });
    const p = bus.request("rpc.slow", { v: 1 }, { target: "slow", timeoutMs: 20 });
    await expect(p).rejects.toThrow(/timeout/);
    await waitForIdle(bus);
    // handler 晚到 resolve；settled=true 守卫使 settleEntry no-op。
    resolveHandler(42);
    await new Promise((r) => setTimeout(r, 0));
    const snap = bus.snapshot();
    expect(snap.completed).toBe(0);
    expect(snap.canceled).toBe(1);
  });

  it("handler rejecting after timeout does not double-count canceled/failed", async () => {
    const bus = createMessageBus();
    let rejectHandler: (e: Error) => void = () => undefined;
    bus.handle("rpc.slow", () => new Promise<number>((_r, rej) => {
      rejectHandler = rej;
    }), { target: "slow" });
    const p = bus.request("rpc.slow", { v: 1 }, { target: "slow", timeoutMs: 20 });
    await expect(p).rejects.toThrow(/timeout/);
    await waitForIdle(bus);
    // handler 晚到 reject；settled=true 守卫使 settleEntry no-op。
    rejectHandler(new Error("late-fetch-error"));
    await new Promise((r) => setTimeout(r, 0));
    const snap = bus.snapshot();
    expect(snap.canceled).toBe(1);
    expect(snap.failed).toBe(0);
  });

  it("queued message canceled before running does not invoke handler", async () => {
    const bus = createMessageBus();
    const ctl = new AbortController();
    let invocations = 0;
    // 第一个 handler 永远 pending，把第二个 entry 留在 mailbox 排队。
    bus.handle("rpc.a", () => new Promise(() => undefined), { target: "queue" });
    bus.handle("rpc.b", () => {
      invocations += 1;
      return 1;
    }, { target: "queue" });
    const pA = bus.request("rpc.a", { v: 1 }, { target: "queue" });
    const pB = bus.request("rpc.b", { v: 1 }, { target: "queue", signal: ctl.signal });
    // 让 pump 把 rpc.a 拉入 inFlight，rpc.b 留在 mailbox。
    await new Promise((r) => setTimeout(r, 0));
    expect(bus.snapshot().inFlight).toBe(1);
    expect(bus.snapshot().queued).toBe(1);
    // 取消 rpc.b（仍排队）；handler 不应被调用。
    ctl.abort(new Error("caller-cancel"));
    await expect(pB).rejects.toThrow(/caller-cancel/);
    await new Promise((r) => setTimeout(r, 0));
    expect(invocations).toBe(0);
    expect(bus.snapshot().queued).toBe(0);
    // 清理 rpc.a 的 pending。
    pA.catch(() => undefined);
  });

  it("dispatch handler timeout counts as canceled exactly once", async () => {
    const bus = createMessageBus();
    bus.handle("cmd.slow", () => new Promise(() => undefined), { target: "cmd" });
    bus.dispatch("cmd.slow", { v: 1 }, { target: "cmd", timeoutMs: 20 });
    await new Promise((r) => setTimeout(r, 30));
    await waitForIdle(bus);
    const snap = bus.snapshot();
    expect(snap.canceled).toBe(1);
    expect(snap.failed).toBe(0);
  });
});

describe("MessageBus waitForHandler (run-time abort)", () => {
  // 设计缘由：handler 可能不监听 message.signal；MessageBus 不能强制打断
  // handler 内部副作用。waitForHandler 只让 MessageBus 停止等待并立即
  // 释放 worker；迟到 resolve/reject 由 settled 守卫 no-op。
  it("worker continues after a running handler ignores abort", async () => {
    const bus = createMessageBus();
    let secondCalled = false;

    bus.handle(
      "cmd.hang",
      () => new Promise(() => undefined),
      { target: "worker" }
    );

    bus.handle(
      "cmd.second",
      () => {
        secondCalled = true;
      },
      { target: "worker" }
    );

    const ctl = new AbortController();
    const first = bus.request(
      "cmd.hang",
      {},
      { target: "worker", signal: ctl.signal }
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    ctl.abort(new Error("stop"));

    await expect(first).rejects.toThrow(/stop/);

    bus.dispatch("cmd.second", {}, { target: "worker" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(secondCalled).toBe(true);
  });
});

describe("MessageBus publish target guard", () => {
  // 设计缘由：带 target 的 handler 属于 actor mailbox，只允许 dispatch/request
  // 触发；publish 绕过会让 concurrency / abort / timeout 管控失效。

  it("publish does not invoke a targeted actor handler", () => {
    const bus = createMessageBus();
    let called = 0;

    bus.handle(
      "actor.only",
      () => {
        called += 1;
      },
      { target: "actor" }
    );

    bus.publish("actor.only", {});
    expect(called).toBe(0);
  });

  it("publish invokes a non-target routed handler", () => {
    const bus = createMessageBus();
    let called = 0;

    bus.handle("event.routed", () => {
      called += 1;
    });

    bus.publish("event.routed", {});
    expect(called).toBe(1);
  });
});

describe("MessageBus.handle concurrency validation", () => {
  // 设计缘由：handler 并发数决定 pump worker 数量；非正整数 / 过大值
  // 都会污染注册状态或一次创建大量 worker。校验必须发生在修改
  // routedHandlers / targetConcurrency / targetHandlerCount / mailboxes
  // 之前。

  it("rejects non-positive and non-integer concurrency without polluting state", () => {
    const bus = createMessageBus();
    for (const value of [0, -1, 1.5, Infinity, NaN]) {
      expect(() =>
        bus.handle("cmd.invalid", () => undefined, {
          target: "worker",
          concurrency: value
        })
      ).toThrow(/positive integer/);
    }
    // 校验失败后 routedHandlers / targetConcurrency / targetHandlerCount /
    // mailboxes 都不应有半初始化状态。
    expect(bus.snapshot().byTarget["worker"] ?? 0).toBe(0);
  });
});
