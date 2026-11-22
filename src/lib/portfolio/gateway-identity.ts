import { z } from "zod";
import { describeError } from "@/lib/portfolio/errors";
import { fetchJSON } from "@/lib/portfolio/fetch-json";

export const GATEWAY_IDENTITY_HEADER = "x-sf-identity";
const EXP_LEEWAY_SECONDS = 10;
const JWKS_REFETCH_COOLDOWN_MS = 30_000;
const JWKS_MAX_AGE_MS = 600_000;
const SEGMENT_RE = /^[A-Za-z0-9_-]+$/;
const ES256 = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" };

const headerSchema = z.looseObject({
  alg: z.literal("ES256"),
  kid: z.string().min(1),
});

const claimsSchema = z.looseObject({
  iss: z.string(),
  aud: z.union([z.string(), z.array(z.string())]),
  exp: z.number(),
  anonymous: z.boolean().optional(),
});

const jwksSchema = z.looseObject({
  keys: z.array(
    z.looseObject({
      kty: z.string().optional(),
      crv: z.string().optional(),
      alg: z.string().optional(),
      kid: z.string().optional(),
      x: z.string().optional(),
      y: z.string().optional(),
    }),
  ),
});

export type GatewayConfig = {
  issuer: string;
  audience: string;
  jwksUrl: string;
};

export type GatewayOutcome =
  | { path: "legacy" }
  | { path: "gateway" }
  | { path: "rejected"; status: 401 | 403 | 503; error: string };

type KeySet = {
  keys: Map<string, CryptoKey>;
  fetchedAt: number;
  ok: boolean;
  pending: Promise<void> | null;
};

const keySets = new Map<string, KeySet>();

export function gatewayConfig(
  env: Record<string, string | undefined> = process.env,
): GatewayConfig | null {
  const issuer = env.SF_GATEWAY_ISSUER?.trim();
  const audience = env.SF_GATEWAY_AUDIENCE?.trim();
  if (!issuer || !audience) return null;
  const jwksUrl =
    env.SF_GATEWAY_JWKS_URL?.trim() ||
    `${issuer.replace(/\/+$/, "")}/.well-known/jwks.json`;
  return { issuer, audience, jwksUrl };
}

function decodeSegment(segment: string): Uint8Array<ArrayBuffer> | null {
  if (!SEGMENT_RE.test(segment)) return null;
  return new Uint8Array(Buffer.from(segment, "base64url"));
}

function decodeJSON(segment: string): unknown {
  const bytes = decodeSegment(segment);
  if (!bytes) return null;
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

async function importKeys(
  jwks: z.output<typeof jwksSchema>,
): Promise<Map<string, CryptoKey>> {
  const usable = jwks.keys.filter(
    (k) =>
      k.kty === "EC" &&
      k.crv === "P-256" &&
      (k.alg === undefined || k.alg === "ES256") &&
      k.kid &&
      k.x &&
      k.y,
  );
  const imported = await Promise.all(
    usable.map(async (k) => {
      try {
        const key = await crypto.subtle.importKey(
          "jwk",
          { kty: "EC", crv: "P-256", x: k.x, y: k.y },
          ES256,
          false,
          ["verify"],
        );
        return [k.kid as string, key] as const;
      } catch {
        return null;
      }
    }),
  );
  return new Map(imported.filter((entry) => entry !== null));
}

async function load(set: KeySet, jwksUrl: string): Promise<void> {
  try {
    const jwks = await fetchJSON(jwksUrl, {
      vendor: "gateway",
      schema: jwksSchema,
      attempts: 2,
      budgetMs: 5_000,
      attemptTimeoutMs: 2_000,
    });
    set.keys = await importKeys(jwks);
    set.ok = true;
  } catch (e) {
    set.ok = false;
    console.error("portfolio: gateway keys unavailable:", describeError(e));
  } finally {
    set.pending = null;
  }
}

async function keyFor(
  kid: string,
  jwksUrl: string,
  now: number,
): Promise<CryptoKey | "unknown" | "unavailable"> {
  let set = keySets.get(jwksUrl);
  if (!set) {
    set = { keys: new Map(), fetchedAt: -Infinity, ok: false, pending: null };
    keySets.set(jwksUrl, set);
  }
  const known = set.keys.has(kid);
  const age = now - set.fetchedAt;
  if (
    !set.pending &&
    age >= (known ? JWKS_MAX_AGE_MS : JWKS_REFETCH_COOLDOWN_MS)
  ) {
    set.fetchedAt = now;
    set.pending = load(set, jwksUrl);
  }
  if (!known && set.pending) await set.pending;
  return set.keys.get(kid) ?? (set.ok ? "unknown" : "unavailable");
}

export async function verifyGatewayIdentity(
  token: string,
  config: GatewayConfig,
  now = Date.now(),
): Promise<"verified" | "anonymous" | "invalid" | "unavailable"> {
  const parts = token.split(".");
  if (parts.length !== 3) return "invalid";
  const [rawHeader, rawClaims, rawSignature] = parts;
  const header = headerSchema.safeParse(decodeJSON(rawHeader));
  const claims = claimsSchema.safeParse(decodeJSON(rawClaims));
  const signature = decodeSegment(rawSignature);
  if (!header.success || !claims.success || signature?.length !== 64) {
    return "invalid";
  }
  const key = await keyFor(header.data.kid, config.jwksUrl, now);
  if (key === "unavailable") return "unavailable";
  if (key === "unknown") return "invalid";
  const signed = new TextEncoder().encode(`${rawHeader}.${rawClaims}`);
  if (!(await crypto.subtle.verify(ES256, key, signature, signed))) {
    return "invalid";
  }
  const { iss, aud, exp, anonymous } = claims.data;
  const audiences = Array.isArray(aud) ? aud : [aud];
  if (iss !== config.issuer || !audiences.includes(config.audience)) {
    return "invalid";
  }
  if (exp + EXP_LEEWAY_SECONDS <= now / 1000) return "invalid";
  return anonymous ? "anonymous" : "verified";
}

export async function checkGatewayIdentity(
  request: Request,
  env: Record<string, string | undefined> = process.env,
  now = Date.now(),
): Promise<GatewayOutcome> {
  const config = gatewayConfig(env);
  const token = request.headers.get(GATEWAY_IDENTITY_HEADER);
  if (!config || token === null) return { path: "legacy" };
  const result = await verifyGatewayIdentity(token, config, now);
  if (result === "verified") return { path: "gateway" };
  if (result === "anonymous") {
    return {
      path: "rejected",
      status: 403,
      error: "Anonymous callers are not allowed.",
    };
  }
  if (result === "unavailable") {
    return {
      path: "rejected",
      status: 503,
      error: "Gateway identity cannot be verified, retry shortly.",
    };
  }
  return { path: "rejected", status: 401, error: "Invalid gateway identity." };
}
