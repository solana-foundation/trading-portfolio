import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acquireLockedClient,
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
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain("waiting for the sync lock");
    for (const c of clients) expect(c.release).toHaveBeenCalledTimes(1);
  });

  it("destroys the connection and rethrows when the lock query fails", async () => {
    const { pool, clients } = fakePool([true], true);
    await expect(
      acquireLockedClient(pool as never, "wallet", Date.now() + 10_000),
    ).rejects.toThrow("db down");
    expect(clients[0].release).toHaveBeenCalledWith(true);
  });
});
