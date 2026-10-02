import { describe, expect, it, vi } from "vitest";
import { withTransaction } from "@/lib/portfolio/value-history";

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
