import { describe, expect, it, vi } from "vitest";
import {
  createLimiter,
  mapLimit,
  QueueTimeoutError,
} from "@/lib/portfolio/concurrency";

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("mapLimit", () => {
  it("preserves input order when tasks resolve out of order", async () => {
    const gates = [deferred<void>(), deferred<void>(), deferred<void>()];
    const run = mapLimit([0, 1, 2], 3, async (i) => {
      await gates[i].promise;
      return i * 10;
    });
    gates[2].resolve();
    gates[0].resolve();
    gates[1].resolve();
    expect(await run).toEqual([0, 10, 20]);
  });

  it("never exceeds the limit", async () => {
    let inFlight = 0;
    let peak = 0;
    const result = await mapLimit(
      Array.from({ length: 12 }, (_, i) => i),
      3,
      async (i) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 1));
        inFlight -= 1;
        return i;
      },
    );
    expect(result).toHaveLength(12);
    expect(peak).toBe(3);
  });

  it("rejects with the first failure", async () => {
    await expect(
      mapLimit([1, 2, 3], 2, async (i) => {
        if (i === 2) throw new Error("boom");
        return i;
      }),
    ).rejects.toThrow("boom");
  });

  it("stops claiming items after the first failure", async () => {
    const started: number[] = [];
    const gates = new Map<number, ReturnType<typeof deferred<void>>>();
    const run = mapLimit(
      Array.from({ length: 10 }, (_, i) => i),
      2,
      async (i) => {
        started.push(i);
        const gate = deferred<void>();
        gates.set(i, gate);
        await gate.promise;
        if (i === 1) throw new Error("boom");
        return i;
      },
    );
    await Promise.resolve();
    expect(started).toEqual([0, 1]);
    gates.get(1)?.resolve();
    await expect(run).rejects.toThrow("boom");
    gates.get(0)?.resolve();
    await new Promise((r) => setTimeout(r, 0));
    expect(started).toEqual([0, 1]);
  });

  it("returns an empty array for empty input", async () => {
    let calls = 0;
    const result = await mapLimit([], 4, async () => {
      calls += 1;
      return 1;
    });
    expect(result).toEqual([]);
    expect(calls).toBe(0);
  });

  it("passes the index to the mapper", async () => {
    const result = await mapLimit(
      ["a", "b"],
      1,
      async (item, i) => `${item}${i}`,
    );
    expect(result).toEqual(["a0", "b1"]);
  });
});

describe("createLimiter", () => {
  it("caps in-flight tasks across independent callers", async () => {
    const limit = createLimiter(2);
    let inFlight = 0;
    let peak = 0;
    const task = async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight -= 1;
      return inFlight;
    };
    await Promise.all([
      Promise.all([limit(task), limit(task), limit(task)]),
      Promise.all([limit(task), limit(task), limit(task)]),
    ]);
    expect(peak).toBe(2);
  });

  it("releases the slot when a task throws", async () => {
    const limit = createLimiter(1);
    await expect(
      limit(async () => {
        throw new Error("fail");
      }),
    ).rejects.toThrow("fail");
    expect(await limit(async () => "ok")).toBe("ok");
  });

  it("rejects a waiter whose queue timeout elapses and leaves the slot to others", async () => {
    vi.useFakeTimers();
    try {
      const limit = createLimiter(1);
      const first = deferred<void>();
      const held = limit(() => first.promise);
      const timedOut = expect(
        limit(async () => "never", { queueTimeoutMs: 100 }),
      ).rejects.toBeInstanceOf(QueueTimeoutError);
      const patient = limit(async () => "ran");
      await vi.advanceTimersByTimeAsync(100);
      await timedOut;
      first.resolve();
      await held;
      expect(await patient).toBe("ran");
    } finally {
      vi.useRealTimers();
    }
  });

  it("runs waiters in FIFO order", async () => {
    const limit = createLimiter(1);
    const order: number[] = [];
    const first = deferred<void>();
    const p1 = limit(async () => {
      await first.promise;
      order.push(1);
    });
    const p2 = limit(async () => {
      order.push(2);
    });
    const p3 = limit(async () => {
      order.push(3);
    });
    first.resolve();
    await Promise.all([p1, p2, p3]);
    expect(order).toEqual([1, 2, 3]);
  });
});
