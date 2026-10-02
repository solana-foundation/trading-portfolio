import { z } from "zod";
import { TtlCache } from "@/lib/portfolio/cache";
import { createLimiter, mapLimit } from "@/lib/portfolio/concurrency";
import {
  describeError,
  ProviderAuthError,
  VendorError,
} from "@/lib/portfolio/errors";
import { type FetchOptions, fetchJSON } from "@/lib/portfolio/fetch-json";
import { MAX_WALLETS_PER_REQUEST } from "@/lib/portfolio/request";
import { SOL_MINT } from "@/lib/portfolio/swaps";
import type {
  HiddenReason,
  Holdings,
  TokenHolding,
} from "@/lib/portfolio/types";

const NATIVE_SOL = "11111111111111111111111111111111";

const CANONICAL_MINTS: Record<string, string> = {
  USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  USDT: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  PYUSD: "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo",
  SOL: SOL_MINT,
};

const DUST_THRESHOLD_USD = 0.01;
const BIRDEYE_CONCURRENCY = 8;
const TOKEN_LIST_CONCURRENCY = 2 * MAX_WALLETS_PER_REQUEST;
const TOKEN_LIST_ATTEMPT_TIMEOUT_MS = 20_000;
const TOKEN_LIST_BUDGET_MS = 40_000;
const NEGATIVE_TTL_MS = 30 * 60 * 1000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

type TokenListItem = {
  symbol?: string;
  name?: string;
  uiAmount?: number;
  priceUsd?: number;
  logoURI?: string;
  address: string;
};

export type TokenMeta = { symbol: string; icon?: string };

const birdeyeGate = createLimiter(BIRDEYE_CONCURRENCY);
const tokenListGate = createLimiter(TOKEN_LIST_CONCURRENCY);
const tokenListCache = new TtlCache<TokenListItem[]>(1_000, 2 * 60 * 1000);
const histPriceCache = new TtlCache<number | null>(10_000, WEEK_MS);
const tokenMetaCache = new TtlCache<TokenMeta | null>(5_000, WEEK_MS);

function negativeTtl<V>(value: V): number | undefined {
  return value === null ? NEGATIVE_TTL_MS : undefined;
}

function birdeyeHeaders(): Record<string, string> {
  const apiKey = process.env.BIRDEYE_API_KEY;
  if (!apiKey) {
    throw new VendorError({
      vendor: "birdeye",
      kind: "config",
      path: "env",
      message: "BIRDEYE_API_KEY is not set",
    });
  }
  return { "x-chain": "solana", "X-API-KEY": apiKey };
}

function birdeyeFetch<S extends z.ZodType>(
  url: string,
  schema: S,
  overrides: Partial<
    Pick<FetchOptions<S>, "attemptTimeoutMs" | "budgetMs" | "gate">
  > = {},
): Promise<z.output<S>> {
  return fetchJSON(url, {
    vendor: "birdeye",
    schema,
    init: { headers: birdeyeHeaders() },
    gate: birdeyeGate,
    ...overrides,
  });
}

const tokenListSchema = z.looseObject({
  success: z.boolean().nullish(),
  message: z.string().nullish(),
  data: z
    .looseObject({
      items: z.array(
        z.looseObject({
          address: z.string(),
          symbol: z.string().nullish(),
          name: z.string().nullish(),
          uiAmount: z.number().nullish(),
          priceUsd: z.number().nullish(),
          logoURI: z.string().nullish(),
        }),
      ),
    })
    .nullish(),
});

const historicalPriceSchema = z.looseObject({
  success: z.boolean().nullish(),
  message: z.string().nullish(),
  data: z.looseObject({ value: z.number().nullish() }).nullish(),
});

const priceSeriesSchema = z.looseObject({
  success: z.boolean().nullish(),
  message: z.string().nullish(),
  data: z
    .looseObject({
      items: z.array(
        z.looseObject({
          unixTime: z.number().nullish(),
          value: z.number().nullish(),
        }),
      ),
    })
    .nullish(),
});

const netWorthSchema = z.looseObject({
  success: z.boolean().nullish(),
  message: z.string().nullish(),
  data: z
    .looseObject({
      history: z
        .array(
          z.looseObject({
            timestamp: z.string().nullish(),
            net_worth: z.number().nullish(),
          }),
        )
        .nullable(),
    })
    .nullish(),
});

function missingCollection(path: string, field: string): VendorError {
  return new VendorError({
    vendor: "birdeye",
    kind: "shape",
    path,
    message: `unexpected response shape for ${path} (data.${field} missing)`,
  });
}

function refusal(
  path: string,
  what: string,
  message: string | null | undefined,
): VendorError {
  return new VendorError({
    vendor: "birdeye",
    kind: "api",
    path,
    message: `Birdeye reported failure for ${what}${message ? `: ${message}` : ""}`,
  });
}

const tokenMetaSchema = z.looseObject({
  success: z.boolean().nullish(),
  data: z
    .looseObject({
      symbol: z.string().nullish(),
      logo_uri: z.string().nullish(),
    })
    .nullish(),
});

function getTokenList(wallet: string): Promise<TokenListItem[]> {
  return tokenListCache.getOrFetch(wallet, () => fetchTokenList(wallet));
}

async function fetchTokenList(wallet: string): Promise<TokenListItem[]> {
  const path = "/v1/wallet/token_list";
  const data = await birdeyeFetch(
    `https://public-api.birdeye.so${path}?wallet=${wallet}`,
    tokenListSchema,
    {
      attemptTimeoutMs: TOKEN_LIST_ATTEMPT_TIMEOUT_MS,
      budgetMs: TOKEN_LIST_BUDGET_MS,
      gate: tokenListGate,
    },
  );
  if (data.success === false) {
    throw refusal(path, `token list of ${wallet.slice(0, 4)}…`, data.message);
  }
  if (!data.data) throw missingCollection(path, "items");
  return data.data.items.map((t) => ({
    address: t.address,
    symbol: t.symbol ?? undefined,
    name: t.name ?? undefined,
    uiAmount: t.uiAmount ?? undefined,
    priceUsd: t.priceUsd ?? undefined,
    logoURI: t.logoURI ?? undefined,
  }));
}

export async function getRawBalances(
  wallet: string,
): Promise<Map<string, number>> {
  const items = await getTokenList(wallet);
  const out = new Map<string, number>();
  for (const t of items) {
    const balance = t.uiAmount || 0;
    if (balance <= 0) continue;
    const mint = t.address === NATIVE_SOL ? SOL_MINT : t.address;
    out.set(mint, (out.get(mint) || 0) + balance);
  }
  return out;
}

export async function getHoldings(wallet: string): Promise<Holdings> {
  const items = await getTokenList(wallet);

  const tokens: TokenHolding[] = items
    .map((t) => ({
      symbol: t.symbol,
      name: t.name,
      balance: t.uiAmount || 0,
      price: t.priceUsd || 0,
      value: (t.uiAmount || 0) * (t.priceUsd || 0),
      icon: t.logoURI,
      address: t.address === NATIVE_SOL ? SOL_MINT : t.address,
    }))
    .map((t) => {
      const hidden = classifyHolding(t);
      return hidden ? { ...t, hidden } : t;
    })
    .sort((a, b) => b.value - a.value);

  const visible = tokens.filter((t) => !t.hidden);
  const unpricedMints = tokens
    .filter((t) => t.hidden === "unpriced")
    .map((t) => t.address);
  return {
    tokens,
    totalValue: visible.reduce((s, t) => s + t.value, 0),
    unpricedCount: unpricedMints.length,
    unpricedMints,
  };
}

export function classifyHolding(
  t: Pick<TokenHolding, "address" | "symbol" | "balance" | "price" | "value">,
): HiddenReason | undefined {
  const canonical = CANONICAL_MINTS[(t.symbol || "").toUpperCase()];
  if (canonical && canonical !== t.address) return "impostor";
  if (t.balance > 0 && t.price <= 0) return "unpriced";
  if (t.value <= DUST_THRESHOLD_USD) return "dust";
  return undefined;
}

function floorDayTs(unixTs: number): number {
  return Math.floor(unixTs / 86_400) * 86_400;
}

async function fetchHistoricalPrice(
  mint: string,
  dayTs: number,
): Promise<number | null> {
  const path = "/defi/historical_price_unix";
  const data = await birdeyeFetch(
    `https://public-api.birdeye.so${path}?address=${mint}&unixtime=${dayTs}`,
    historicalPriceSchema,
  );
  if (data.success !== true) {
    const detail =
      data.success === false
        ? `reported failure${data.message ? `: ${data.message}` : ""}`
        : "answered without a success flag";
    throw new VendorError({
      vendor: "birdeye",
      kind: "api",
      path,
      message: `Birdeye ${detail} for ${mint.slice(0, 4)}…@${dayTs}`,
    });
  }
  return typeof data.data?.value === "number" ? data.data.value : null;
}

export function isBirdeyeRefusal(e: unknown): e is VendorError {
  return e instanceof VendorError && e.vendor === "birdeye" && e.kind === "api";
}

export async function getHistoricalPrice(
  mint: string,
  unixTs: number,
): Promise<number | null> {
  if (!unixTs || unixTs <= 0) return null;
  const dayTs = floorDayTs(unixTs);
  try {
    return await histPriceCache.getOrFetch(
      `${mint}:${dayTs}`,
      () => fetchHistoricalPrice(mint, dayTs),
      negativeTtl,
    );
  } catch (e) {
    if (!isBirdeyeRefusal(e)) throw e;
    console.warn(`portfolio: ${describeError(e)}`);
    return null;
  }
}

export async function getHistoricalPrices(
  queries: ReadonlyArray<{ mint: string; ts: number }>,
): Promise<Map<string, number | null>> {
  const unique = new Map<string, { mint: string; dayTs: number }>();
  for (const q of queries) {
    if (!q.ts || q.ts <= 0) continue;
    const dayTs = floorDayTs(q.ts);
    unique.set(`${q.mint}:${dayTs}`, { mint: q.mint, dayTs });
  }
  const entries = Array.from(unique.entries());
  const prices = await mapLimit(entries, BIRDEYE_CONCURRENCY, ([, q]) =>
    getHistoricalPrice(q.mint, q.dayTs),
  );
  const out = new Map<string, number | null>();
  for (let i = 0; i < entries.length; i++) out.set(entries[i][0], prices[i]);
  return out;
}

const SERIES_CHUNK_DAYS = 800;

export async function getPriceSeries(
  mint: string,
  fromTs: number,
  toTs: number,
): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  const path = "/defi/history_price";
  for (let from = fromTs; from <= toTs; from += SERIES_CHUNK_DAYS * 86_400) {
    const to = Math.min(from + SERIES_CHUNK_DAYS * 86_400 - 1, toTs);
    const data = await birdeyeFetch(
      `https://public-api.birdeye.so${path}?address=${mint}&address_type=token&type=1D&time_from=${from}&time_to=${to}`,
      priceSeriesSchema,
    );
    if (data.success !== true) {
      throw refusal(path, `price series of ${mint.slice(0, 4)}…`, data.message);
    }
    if (!data.data) throw missingCollection(path, "items");
    for (const item of data.data.items) {
      if (
        typeof item.unixTime === "number" &&
        typeof item.value === "number" &&
        item.value > 0
      ) {
        out.set(floorDayTs(item.unixTime), item.value);
      }
    }
  }
  return out;
}

const NET_WORTH_MAX_DAYS = 90;

export async function getNetWorthHistory(
  wallet: string,
): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  const path = "/wallet/v2/net-worth";
  const data = await birdeyeFetch(
    `https://public-api.birdeye.so${path}?wallet=${wallet}&count=${NET_WORTH_MAX_DAYS}&direction=back&type=1d`,
    netWorthSchema,
  );
  if (data.success === false) {
    throw refusal(path, `net worth of ${wallet.slice(0, 4)}…`, data.message);
  }
  if (!data.data) throw missingCollection(path, "history");
  const today = floorDayTs(Math.floor(Date.now() / 1000));
  for (const row of data.data.history ?? []) {
    if (!row.timestamp || typeof row.net_worth !== "number") continue;
    const ts = Math.floor(Date.parse(row.timestamp) / 1000);
    if (!Number.isFinite(ts)) continue;
    const day = floorDayTs(ts);
    if (day >= today) continue;
    if (!out.has(day)) out.set(day, row.net_worth);
  }
  return out;
}

async function fetchTokenMeta(mint: string): Promise<TokenMeta | null> {
  const data = await birdeyeFetch(
    `https://public-api.birdeye.so/defi/v3/token/meta-data/single?address=${mint}`,
    tokenMetaSchema,
  );
  if (data.success !== true) {
    throw new VendorError({
      vendor: "birdeye",
      kind: "api",
      path: "/defi/v3/token/meta-data/single",
      message: `Birdeye ${data.success === false ? "reported failure" : "answered without a success flag"} for metadata of ${mint.slice(0, 4)}…`,
    });
  }
  if (data.data?.symbol) {
    return {
      symbol: data.data.symbol,
      ...(data.data.logo_uri ? { icon: data.data.logo_uri } : {}),
    };
  }
  return null;
}

export async function getTokenMeta(mint: string): Promise<TokenMeta | null> {
  try {
    return await tokenMetaCache.getOrFetch(
      mint,
      () => fetchTokenMeta(mint),
      negativeTtl,
    );
  } catch (e) {
    if (e instanceof ProviderAuthError) throw e;
    if (e instanceof VendorError && e.kind === "config") throw e;
    console.warn(
      `portfolio: Birdeye token meta unavailable for ${mint.slice(0, 4)}…: ${describeError(e)}`,
    );
    return null;
  }
}

export async function getTokenMetas(
  mints: ReadonlyArray<string>,
): Promise<Map<string, TokenMeta>> {
  const unique = Array.from(new Set(mints));
  const metas = await mapLimit(unique, BIRDEYE_CONCURRENCY, (mint) =>
    getTokenMeta(mint),
  );
  const out = new Map<string, TokenMeta>();
  unique.forEach((mint, i) => {
    const meta = metas[i];
    if (meta) out.set(mint, meta);
  });
  return out;
}
