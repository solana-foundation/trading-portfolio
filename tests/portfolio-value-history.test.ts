import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeadlineError } from "@/lib/portfolio/deadline";
import {
  acquireLockedClient,
  joinOrQueue,
  seriesOrSkip,
  withTransaction,
} from "@/lib/portfolio/value-history";

function fakeClient(failOn?: string) {
  const calls: string[] = [];
  const query = vi.fn(async (sql: string) => {
    calls.push(sql);
    if (failOn && sql === failOn) throw new Error(`fail ${sql}`);
    return { rows: [] };
  });
  return { client: { query }, calls };
}

describe("withTransaction", () => {
  it("wraps the body in BEGIN and COMMIT and returns its value", async () => {
    const { client, calls } = fakeClient();
    const result = await withTransaction(client as never, async () => {
      await client.query("INSERT 1");
      return 7;
    });
    expect(result).toBe(7);
    expect(calls).toEqual(["BEGIN", "INSERT 1", "COMMIT"]);
  });

  it("rolls back and rethrows when the body throws", async () => {
    const { client, calls } = fakeClient();
    await expect(
      withTransaction(client as never, async () => {
        await client.query("INSERT 1");
        throw new Error("body failed");
      }),
    ).rejects.toThrow("body failed");
    expect(calls).toEqual(["BEGIN", "INSERT 1", "ROLLBACK"]);
  });

  it("surfaces the original error when ROLLBACK itself fails", async () => {
    const { client, calls } = fakeClient("ROLLBACK");
    await expect(
      withTransaction(client as never, async () => {
        throw new Error("body failed");
      }),
    ).rejects.toThrow("body failed");
    expect(calls).toEqual(["BEGIN", "ROLLBACK"]);
  });

  it("propagates a COMMIT failure", async () => {
    const { client } = fakeClient("COMMIT");
    await expect(
      withTransaction(client as never, async () => 1),
    ).rejects.toThrow("fail COMMIT");
  });
});

function fakePool(lockedSequence: boolean[], failOnQuery = false) {
  const clients: Array<{
    query: ReturnType<typeof vi.fn>;
    release: ReturnType<typeof vi.fn>;
  }> = [];
  let i = 0;
  const pool = {
    connect: vi.fn(async () => {
      const locked = lockedSequence[i] ?? false;
      i += 1;
      const client = {
        query: vi.fn(async () => {
          if (failOnQuery) throw new Error("db down");
          return { rows: [{ locked }] };
        }),
        release: vi.fn(),
      };
      clients.push(client);
      return client;
    }),
  };
  return { pool, clients };
}

describe("acquireLockedClient", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns a pooled connection between polls and keeps the one that got the lock", async () => {
    const { pool, clients } = fakePool([false, false, true]);
    const p = acquireLockedClient(pool as never, "wallet", Date.now() + 10_000);
    await vi.runAllTimersAsync();
    const client = await p;
    expect(pool.connect).toHaveBeenCalledTimes(3);
    expect(clients[0].release).toHaveBeenCalledWith();
    expect(clients[1].release).toHaveBeenCalledWith();
    expect(clients[2].release).not.toHaveBeenCalled();
    expect(client).toBe(clients[2]);
    expect(String(clients[2].query.mock.calls[0][0])).toContain(
      "pg_try_advisory_lock",
    );
  });

  it("gives up at the deadline with every connection returned", async () => {
    const { pool, clients } = fakePool([false, false, false, false]);
    const p = acquireLockedClient(
      pool as never,
      "wallet",
      Date.now() + 1_200,
    ).catch((e) => e);
    await vi.runAllTimersAsync();
    const err = await p;
    expect(err).toBeInstanceOf(DeadlineError);
    expect(err.message).toContain("waiting for the sync lock");
    for (const c of clients) expect(c.release).toHaveBeenCalledTimes(1);
  });

  it("does not try the lock when the pool checkout outlasted the deadline", async () => {
    vi.setSystemTime(1_000_000);
    const client = { query: vi.fn(), release: vi.fn() };
    const pool = {
      connect: vi.fn(async () => {
        vi.setSystemTime(1_010_000);
        return client;
      }),
    };
    await expect(
      acquireLockedClient(pool as never, "wallet", 1_005_000),
    ).rejects.toBeInstanceOf(DeadlineError);
    expect(client.query).not.toHaveBeenCalled();
    expect(client.release).toHaveBeenCalledTimes(1);
    expect(client.release).toHaveBeenCalledWith();
  });

  it("releases a lock won after the deadline instead of starting the sync", async () => {
    vi.setSystemTime(1_000_000);
    const client = {
      query: vi.fn(async (sql: string) => {
        if (String(sql).includes("pg_try_advisory_lock")) {
          vi.setSystemTime(1_010_000);
          return { rows: [{ locked: true }] };
        }
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const pool = { connect: vi.fn(async () => client) };
    await expect(
      acquireLockedClient(pool as never, "wallet", 1_005_000),
    ).rejects.toBeInstanceOf(DeadlineError);
    const sqls = client.query.mock.calls.map((c) => String(c[0]));
    expect(sqls.some((q) => q.includes("pg_advisory_unlock"))).toBe(true);
    expect(client.release).toHaveBeenCalledWith(false);
  });

  it("destroys the connection and rethrows when the lock query fails", async () => {
    const { pool, clients } = fakePool([true], true);
    await expect(
      acquireLockedClient(pool as never, "wallet", Date.now() + 10_000),
    ).rejects.toThrow("db down");
    expect(clients[0].release).toHaveBeenCalledWith(true);
  });
});

describe("seriesOrSkip", () => {
  it("fetches before the deadline and skips after it", async () => {
    const fetchSeries = vi.fn(async () => new Map([[86_400, 2]]));
    const before = await seriesOrSkip(
      "m",
      0,
      1,
      Date.now() + 10_000,
      fetchSeries,
    );
    expect(before?.get(86_400)).toBe(2);
    expect(fetchSeries).toHaveBeenCalledTimes(1);
    expect(seriesOrSkip("m", 0, 1, Date.now() - 1, fetchSeries)).toBeNull();
    expect(fetchSeries).toHaveBeenCalledTimes(1);
  });
});

describe("joinOrQueue", () => {
  it("shares an in-flight sync for the same day", async () => {
    const map = new Map<string, { day: number; promise: Promise<string> }>();
    const run = vi.fn(async () => "shared");
    const a = joinOrQueue(map, "w", 1, run);
    const b = joinOrQueue(map, "w", 1, run);
    expect(a).toBe(b);
    expect(await b).toBe("shared");
    expect(run).toHaveBeenCalledTimes(1);
    expect(map.size).toBe(0);
  });

  it("queues a different day behind the in-flight sync and runs it on its own", async () => {
    const map = new Map<string, { day: number; promise: Promise<string> }>();
    let releaseFirst!: () => void;
    const gate = new Promise<void>((r) => {
      releaseFirst = r;
    });
    const order: string[] = [];
    const first = joinOrQueue(map, "w", 1, async () => {
      order.push("day1 start");
      await gate;
      order.push("day1 end");
      throw new Error("day1 failed");
    });
    const second = joinOrQueue(map, "w", 2, async () => {
      order.push("day2 start");
      return "day2 ok";
    });
    await Promise.resolve();
    expect(order).toEqual(["day1 start"]);
    releaseFirst();
    await expect(first).rejects.toThrow("day1 failed");
    expect(await second).toBe("day2 ok");
    expect(order).toEqual(["day1 start", "day1 end", "day2 start"]);
    expect(map.size).toBe(0);
  });
});
