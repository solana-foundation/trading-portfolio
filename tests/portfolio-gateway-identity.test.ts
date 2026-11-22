import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ISSUER = "https://issuer.test";
const AUDIENCE = "portfolio";
const JWKS_URL = `${ISSUER}/.well-known/jwks.json`;
const KID = "test-1";
const WALLET = "86xCnPeV69n6t3DnyGvkKobf9FdN2H9oiVDdaMpo2MMY";
const ALGORITHM = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" };

type Keys = { privateKey: CryptoKey; jwk: JsonWebKey };

const fetchMock = vi.fn<typeof fetch>();
let signer: Keys;
let other: Keys;

async function generate(): Promise<Keys> {
  const pair = await crypto.subtle.generateKey(ALGORITHM, true, [
    "sign",
    "verify",
  ]);
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return { privateKey: pair.privateKey, jwk };
}

function b64url(value: unknown): string {
  const bytes =
    value instanceof Uint8Array
      ? value
      : new TextEncoder().encode(JSON.stringify(value));
  return Buffer.from(bytes).toString("base64url");
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function claims(overrides: Record<string, unknown> = {}) {
  return {
    iss: ISSUER,
    aud: AUDIENCE,
    iat: nowSeconds(),
    exp: nowSeconds() + 60,
    org_id: "tokens-42",
    project_id: "tokens-42",
    key_id: "key-1",
    clerk_user_id: null,
    plan: "internal",
    grants: [AUDIENCE],
    client_ip: "203.0.113.9",
    request_id: "req-1",
    ...overrides,
  };
}

async function sign(
  payload: Record<string, unknown> = claims(),
  header: Record<string, unknown> = { alg: "ES256", typ: "JWT", kid: KID },
  key: CryptoKey = signer.privateKey,
): Promise<string> {
  const input = `${b64url(header)}.${b64url(payload)}`;
  const signature = await crypto.subtle.sign(
    ALGORITHM,
    key,
    new TextEncoder().encode(input),
  );
  return `${input}.${b64url(new Uint8Array(signature))}`;
}

function jwks(...entries: [string, JsonWebKey][]) {
  return {
    keys: [
      { kty: "RSA", kid: "rsa-1", n: "AQAB", e: "AQAB" },
      ...entries.map(([kid, jwk]) => ({
        kty: "EC",
        crv: "P-256",
        alg: "ES256",
        use: "sig",
        kid,
        x: jwk.x,
        y: jwk.y,
      })),
    ],
  };
}

function serveJwks(body: unknown, status = 200) {
  fetchMock.mockImplementation(async () => Response.json(body, { status }));
}

function post(body: string, identity?: string): Request {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (identity !== undefined) headers["x-sf-identity"] = identity;
  return new Request("http://localhost/api/portfolio/summary", {
    method: "POST",
    headers,
    body,
  });
}

function enable() {
  vi.stubEnv("SF_GATEWAY_ISSUER", ISSUER);
  vi.stubEnv("SF_GATEWAY_AUDIENCE", AUDIENCE);
}

async function load() {
  const request = await import("@/lib/portfolio/request");
  const identity = await import("@/lib/portfolio/gateway-identity");
  return { ...request, ...identity };
}

async function statuses(
  parse: (r: Request) => Promise<{ ok: boolean; status?: number }>,
  count: number,
  identity?: string,
): Promise<(number | undefined)[]> {
  const out: (number | undefined)[] = [];
  for (let i = 0; i < count; i++) {
    out.push((await parse(post("{}", identity))).status);
  }
  return out;
}

beforeEach(async () => {
  vi.resetModules();
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(Math, "random").mockReturnValue(0);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubEnv("SF_GATEWAY_ISSUER", "");
  vi.stubEnv("SF_GATEWAY_AUDIENCE", "");
  vi.stubEnv("SF_GATEWAY_JWKS_URL", "");
  fetchMock.mockReset();
  signer ??= await generate();
  other ??= await generate();
  serveJwks(jwks([KID, signer.jwk]));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("gatewayConfig", () => {
  it("is off unless both issuer and audience are set", async () => {
    const { gatewayConfig } = await load();
    expect(gatewayConfig({})).toBeNull();
    expect(gatewayConfig({ SF_GATEWAY_ISSUER: ISSUER })).toBeNull();
    expect(gatewayConfig({ SF_GATEWAY_AUDIENCE: AUDIENCE })).toBeNull();
    expect(
      gatewayConfig({ SF_GATEWAY_ISSUER: " ", SF_GATEWAY_AUDIENCE: AUDIENCE }),
    ).toBeNull();
  });

  it("derives the JWKS URL from the issuer unless one is given", async () => {
    const { gatewayConfig } = await load();
    expect(
      gatewayConfig({
        SF_GATEWAY_ISSUER: `${ISSUER}/`,
        SF_GATEWAY_AUDIENCE: AUDIENCE,
      }),
    ).toEqual({ issuer: `${ISSUER}/`, audience: AUDIENCE, jwksUrl: JWKS_URL });
    expect(
      gatewayConfig({
        SF_GATEWAY_ISSUER: ISSUER,
        SF_GATEWAY_AUDIENCE: AUDIENCE,
        SF_GATEWAY_JWKS_URL: "https://keys.test/jwks",
      })?.jwksUrl,
    ).toBe("https://keys.test/jwks");
  });
});

describe("legacy path", () => {
  it("ignores X-SF-Identity and keeps the limiter when the gateway path is off", async () => {
    const { parseWalletsBody } = await load();
    const token = await sign();
    const results = [
      ...(await statuses(parseWalletsBody, 15, token)),
      ...(await statuses(parseWalletsBody, 15, "junk")),
    ];
    expect(results).toEqual(Array(30).fill(400));
    expect(await parseWalletsBody(post("{}", token))).toMatchObject({
      status: 429,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps the limiter for requests without X-SF-Identity when the gateway path is on", async () => {
    enable();
    const { parseWalletsBody } = await load();
    expect(await statuses(parseWalletsBody, 30)).toEqual(Array(30).fill(400));
    expect(await parseWalletsBody(post("{}"))).toMatchObject({ status: 429 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("gateway path", () => {
  it("skips the limiter for a valid identity and caches the JWKS", async () => {
    enable();
    const { parseWalletsBody } = await load();
    const token = await sign();
    expect(await statuses(parseWalletsBody, 40, token)).toEqual(
      Array(40).fill(400),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(JWKS_URL);
    expect(
      await parseWalletsBody(post(`{"wallets":["${WALLET}"]}`, token)),
    ).toEqual({ ok: true, wallets: [WALLET], body: {} });
  });

  it("does not use up the legacy limiter", async () => {
    enable();
    const { parseWalletsBody } = await load();
    await statuses(parseWalletsBody, 40, await sign());
    expect(await statuses(parseWalletsBody, 30)).toEqual(Array(30).fill(400));
    expect(await parseWalletsBody(post("{}"))).toMatchObject({ status: 429 });
  });

  it("serves projects it has no row for and Clerk identities without a project", async () => {
    enable();
    const { checkGatewayIdentity } = await load();
    const portal = await sign(
      claims({ org_id: "org_portal", project_id: "proj_portal", grants: [] }),
    );
    const clerk = await sign(
      claims({
        org_id: null,
        project_id: null,
        key_id: null,
        clerk_user_id: "user_1",
        plan: null,
        grants: [],
      }),
    );
    for (const token of [portal, clerk]) {
      expect(await checkGatewayIdentity(post("{}", token))).toEqual({
        path: "gateway",
      });
    }
  });

  it("accepts an audience list that holds the audience", async () => {
    enable();
    const { checkGatewayIdentity } = await load();
    const token = await sign(claims({ aud: ["other", AUDIENCE] }));
    expect(await checkGatewayIdentity(post("{}", token))).toEqual({
      path: "gateway",
    });
  });

  it("accepts a token that expired within the leeway", async () => {
    enable();
    const { checkGatewayIdentity } = await load();
    const token = await sign(claims({ exp: nowSeconds() - 5 }));
    expect(await checkGatewayIdentity(post("{}", token))).toEqual({
      path: "gateway",
    });
  });

  it("uses SF_GATEWAY_JWKS_URL when set", async () => {
    enable();
    vi.stubEnv("SF_GATEWAY_JWKS_URL", "https://keys.test/jwks");
    const { checkGatewayIdentity } = await load();
    expect(await checkGatewayIdentity(post("{}", await sign()))).toEqual({
      path: "gateway",
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://keys.test/jwks");
  });

  it("rejects anonymous identities with 403", async () => {
    enable();
    const { parseWalletsBody } = await load();
    const token = await sign(
      claims({
        org_id: null,
        project_id: null,
        key_id: null,
        plan: null,
        grants: [],
        anonymous: true,
      }),
    );
    expect(
      await parseWalletsBody(post(`{"wallets":["${WALLET}"]}`, token)),
    ).toEqual({
      ok: false,
      error: "Anonymous callers are not allowed.",
      status: 403,
    });
  });
});

describe("invalid identities", () => {
  const invalid: [string, () => Promise<string>][] = [
    [
      "expired beyond the leeway",
      () => sign(claims({ exp: nowSeconds() - 11 })),
    ],
    ["wrong issuer", () => sign(claims({ iss: "https://other.test" }))],
    ["wrong audience", () => sign(claims({ aud: "tokens" }))],
    [
      "audience list without the audience",
      () => sign(claims({ aud: ["tokens", "sdp"] })),
    ],
    ["missing exp", () => sign(claims({ exp: undefined }))],
    ["unknown kid", () => sign(claims(), { alg: "ES256", kid: "other" })],
    ["missing kid", () => sign(claims(), { alg: "ES256" })],
    [
      "bad signature",
      () => sign(claims(), { alg: "ES256", kid: KID }, other.privateKey),
    ],
    [
      "tampered claims",
      async () => {
        const [h, , s] = (await sign()).split(".");
        return `${h}.${b64url(claims({ project_id: "tokens-1" }))}.${s}`;
      },
    ],
    [
      "alg none",
      async () => `${b64url({ alg: "none", kid: KID })}.${b64url(claims())}.`,
    ],
    [
      "alg HS256",
      async () => {
        const input = `${b64url({ alg: "HS256", kid: KID })}.${b64url(claims())}`;
        const key = await crypto.subtle.importKey(
          "raw",
          new TextEncoder().encode(JSON.stringify(signer.jwk)),
          { name: "HMAC", hash: "SHA-256" },
          false,
          ["sign"],
        );
        const mac = await crypto.subtle.sign(
          "HMAC",
          key,
          new TextEncoder().encode(input),
        );
        return `${input}.${b64url(new Uint8Array(mac))}`;
      },
    ],
    ["empty", async () => ""],
    [
      "two segments",
      async () => (await sign()).split(".").slice(0, 2).join("."),
    ],
    ["not base64url", async () => "a+b.c/d.e=f"],
    [
      "header not JSON",
      async () => {
        const [, p, s] = (await sign()).split(".");
        return `${Buffer.from("nope").toString("base64url")}.${p}.${s}`;
      },
    ],
    [
      "short signature",
      async () => {
        const [h, p] = (await sign()).split(".");
        return `${h}.${p}.${b64url(new Uint8Array(32))}`;
      },
    ],
  ];

  for (const [name, make] of invalid) {
    it(`returns 401 for ${name}, never the legacy path`, async () => {
      enable();
      const { parseWalletsBody } = await load();
      const token = await make();
      expect(
        await parseWalletsBody(post(`{"wallets":["${WALLET}"]}`, token)),
      ).toEqual({ ok: false, error: "Invalid gateway identity.", status: 401 });
    });
  }

  it("never fetches the JWKS for a malformed token", async () => {
    enable();
    const { checkGatewayIdentity } = await load();
    await checkGatewayIdentity(post("{}", "a.b.c"));
    await checkGatewayIdentity(post("{}", "junk"));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("JWKS cache", () => {
  const LONG = { exp: nowSeconds() + 3_600 };

  async function at(token: string, now: number) {
    const { checkGatewayIdentity } = await import(
      "@/lib/portfolio/gateway-identity"
    );
    return checkGatewayIdentity(post("{}", token), process.env, now);
  }

  it("refetches an unknown kid at most once per cooldown and picks up a new key", async () => {
    enable();
    const t0 = Date.now();
    const current = await sign(claims(LONG));
    const rotated = await sign(
      claims(LONG),
      { alg: "ES256", kid: "test-2" },
      other.privateKey,
    );
    const rejected = { path: "rejected", status: 401 };
    expect(await at(current, t0)).toEqual({ path: "gateway" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await at(rotated, t0 + 1_000)).toMatchObject(rejected);
    expect(await at(rotated, t0 + 29_000)).toMatchObject(rejected);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await at(rotated, t0 + 31_000)).toMatchObject(rejected);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    serveJwks(jwks([KID, signer.jwk], ["test-2", other.jwk]));
    expect(await at(rotated, t0 + 40_000)).toMatchObject(rejected);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(await at(rotated, t0 + 62_000)).toEqual({ path: "gateway" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("shares one JWKS fetch between concurrent requests", async () => {
    enable();
    const { parseWalletsBody } = await load();
    const token = await sign();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => parseWalletsBody(post("{}", token))),
    );
    expect(results).toEqual(
      Array(5).fill(expect.objectContaining({ status: 400 })),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("drops a key the JWKS no longer serves once the cache is stale", async () => {
    enable();
    const t0 = Date.now();
    const token = await sign(claims(LONG));
    expect(await at(token, t0)).toEqual({ path: "gateway" });
    serveJwks(jwks(["test-2", other.jwk]));
    expect(await at(token, t0 + 600_000)).toEqual({ path: "gateway" });
    await vi.waitFor(async () =>
      expect(await at(token, t0 + 600_001)).toMatchObject({ status: 401 }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns 503 when the JWKS is unreachable and no key is cached", async () => {
    enable();
    serveJwks({ error: "down" }, 503);
    const { parseWalletsBody } = await load();
    expect(await parseWalletsBody(post("{}", await sign()))).toEqual({
      ok: false,
      error: "Gateway identity cannot be verified, retry shortly.",
      status: 503,
    });
  });

  it("keeps serving cached keys while the JWKS is unreachable", async () => {
    enable();
    const t0 = Date.now();
    const token = await sign(claims(LONG));
    expect(await at(token, t0)).toEqual({ path: "gateway" });
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    expect(await at(token, t0 + 600_000)).toEqual({ path: "gateway" });
    const rotated = await sign(
      claims(LONG),
      { alg: "ES256", kid: "test-2" },
      other.privateKey,
    );
    expect(await at(rotated, t0 + 700_000)).toMatchObject({ status: 503 });
  });
});
