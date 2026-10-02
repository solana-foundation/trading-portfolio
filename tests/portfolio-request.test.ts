import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  MAX_WALLETS_PER_REQUEST,
  parseWalletsBody,
  walletsBodySchema,
} from "@/lib/portfolio/request";

const WALLET = "86xCnPeV69n6t3DnyGvkKobf9FdN2H9oiVDdaMpo2MMY";
const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZ";

function syntheticWallets(count: number): string[] {
  return Array.from({ length: count }, (_, i) => "1".repeat(31) + BASE58[i]);
}

function firstMessage(
  result: z.ZodSafeParseResult<unknown>,
): string | undefined {
  return result.success ? undefined : result.error.issues[0]?.message;
}

function post(body: string): Request {
  return new Request("http://localhost/api/portfolio/summary", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

describe("walletsBodySchema", () => {
  it("accepts a valid wallet list", () => {
    const result = walletsBodySchema.safeParse({ wallets: [WALLET] });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.wallets).toEqual([WALLET]);
  });

  it("dedupes repeated wallets", () => {
    const result = walletsBodySchema.safeParse({ wallets: [WALLET, WALLET] });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.wallets).toEqual([WALLET]);
  });

  it("accepts exactly the maximum number of wallets", () => {
    const result = walletsBodySchema.safeParse({
      wallets: syntheticWallets(MAX_WALLETS_PER_REQUEST),
    });
    expect(result.success).toBe(true);
  });

  it("rejects a missing wallets field with a stable message", () => {
    expect(firstMessage(walletsBodySchema.safeParse({}))).toBe(
      "wallets must be an array of Solana addresses",
    );
  });

  it("rejects a non-array wallets field with a stable message", () => {
    expect(firstMessage(walletsBodySchema.safeParse({ wallets: "x" }))).toBe(
      "wallets must be an array of Solana addresses",
    );
  });

  it("rejects an empty wallet list", () => {
    expect(firstMessage(walletsBodySchema.safeParse({ wallets: [] }))).toBe(
      "wallets must contain at least 1 address",
    );
  });

  it("rejects more than the maximum number of wallets", () => {
    const result = walletsBodySchema.safeParse({
      wallets: syntheticWallets(MAX_WALLETS_PER_REQUEST + 1),
    });
    expect(firstMessage(result)).toBe(
      `wallets must contain at most ${MAX_WALLETS_PER_REQUEST} addresses`,
    );
  });

  it("rejects a non-base58 wallet", () => {
    expect(
      firstMessage(walletsBodySchema.safeParse({ wallets: ["bad"] })),
    ).toBe("invalid Solana address");
  });

  it("extends with extra fields", () => {
    const schema = walletsBodySchema.extend({
      limit: z.number().int().min(1).max(500).optional(),
    });
    expect(schema.safeParse({ wallets: [WALLET], limit: 10 }).success).toBe(
      true,
    );
    expect(schema.safeParse({ wallets: [WALLET], limit: 0 }).success).toBe(
      false,
    );
    expect(schema.safeParse({ wallets: [WALLET] }).success).toBe(true);
  });
});

describe("parseWalletsBody", () => {
  it("returns 400 for malformed JSON", async () => {
    const result = await parseWalletsBody(post("{"));
    expect(result).toEqual({
      ok: false,
      error: "Invalid JSON body.",
      status: 400,
    });
  });

  it("returns 400 with the schema message for an invalid body", async () => {
    const result = await parseWalletsBody(post("{}"));
    expect(result).toEqual({
      ok: false,
      error: "wallets must be an array of Solana addresses",
      status: 400,
    });
  });

  it("separates wallets from extra body fields", async () => {
    const result = await parseWalletsBody(
      post(JSON.stringify({ wallets: [WALLET, WALLET], limit: 5 })),
      { limit: z.number().int().optional() },
    );
    expect(result).toEqual({ ok: true, wallets: [WALLET], body: { limit: 5 } });
  });
});
