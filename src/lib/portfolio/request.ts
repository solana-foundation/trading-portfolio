import { z } from "zod";

export const MAX_WALLETS_PER_REQUEST = 20;

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export const walletsBodySchema = z.object({
  wallets: z
    .array(z.string().regex(BASE58_RE, "invalid Solana address"))
    .min(1)
    .max(MAX_WALLETS_PER_REQUEST)
    .transform((ws) => Array.from(new Set(ws))),
});

export type WalletsBody = z.infer<typeof walletsBodySchema>;

export async function parseWalletsBody(
  request: Request,
  extra?: z.ZodRawShape,
): Promise<
  | { ok: true; wallets: string[]; body: Record<string, unknown> }
  | { ok: false; error: string }
> {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return { ok: false, error: "Invalid JSON body." };
  }
  const schema = extra ? walletsBodySchema.extend(extra) : walletsBodySchema;
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message || "Invalid body." };
  }
  const { wallets, ...rest } = parsed.data as WalletsBody & Record<string, unknown>;
  return { ok: true, wallets, body: rest };
}
