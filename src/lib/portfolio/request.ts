import { z } from "zod";

export const MAX_WALLETS_PER_REQUEST = 20;

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export const walletsBodySchema = z.object({
  wallets: z
    .array(z.string().regex(BASE58_RE, { error: "invalid Solana address" }), {
      error: "wallets must be an array of Solana addresses",
    })
    .min(1, { error: "wallets must contain at least 1 address" })
    .max(MAX_WALLETS_PER_REQUEST, {
      error: `wallets must contain at most ${MAX_WALLETS_PER_REQUEST} addresses`,
    })
    .transform((ws) => Array.from(new Set(ws))),
});

export type WalletsBody = z.infer<typeof walletsBodySchema>;

export function createRateLimiter(capacity: number, refillPerMinute: number) {
  let tokens = capacity;
  let last: number | null = null;
  return (now = Date.now()) => {
    const elapsed = last === null ? 0 : Math.max(0, now - last);
    tokens = Math.min(capacity, tokens + (elapsed / 60_000) * refillPerMinute);
    last = now;
    if (tokens < 1) return false;
    tokens -= 1;
    return true;
  };
}

const takeRequestToken = createRateLimiter(30, 30);

export async function parseWalletsBody(
  request: Request,
  extra?: z.ZodRawShape,
): Promise<
  | { ok: true; wallets: string[]; body: Record<string, unknown> }
  | { ok: false; error: string; status: 400 | 429 }
> {
  if (!takeRequestToken()) {
    return {
      ok: false,
      error: "Rate limit exceeded, retry shortly.",
      status: 429,
    };
  }
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return { ok: false, error: "Invalid JSON body.", status: 400 };
  }
  const schema = extra ? walletsBodySchema.extend(extra) : walletsBodySchema;
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message || "Invalid body.",
      status: 400,
    };
  }
  const { wallets, ...rest } = parsed.data as WalletsBody &
    Record<string, unknown>;
  return { ok: true, wallets, body: rest };
}
