import { z } from "zod";
import { TtlCache } from "@/lib/portfolio/cache";
import { fetchJSON } from "@/lib/portfolio/fetch-json";
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

type TokenListItem = {
  symbol?: string;
  name?: string;
  uiAmount?: number;
  priceUsd?: number;
  logoURI?: string;
  address: string;
};

const tokenListCache = new TtlCache<TokenListItem[]>(1_000, 2 * 60 * 1000);
const histPriceCache = new TtlCache<number>(10_000, 7 * 24 * 60 * 60 * 1000);
const tokenMetaCache = new TtlCache<{ symbol: string; icon?: string }>(
  5_000,
  7 * 24 * 60 * 60 * 1000,
);

function birdeyeHeaders(): Record<string, string> {
  const apiKey = process.env.BIRDEYE_API_KEY;
  if (!apiKey) throw new Error("BIRDEYE_API_KEY is not set");
  return { "x-chain": "solana", "X-API-KEY": apiKey };
}

const tokenListSchema = z.looseObject({
  data: z
    .looseObject({
      items: z
        .array(
          z.looseObject({
            address: z.string(),
            symbol: z.string().nullish(),
            name: z.string().nullish(),
            uiAmount: z.number().nullish(),
            priceUsd: z.number().nullish(),
            logoURI: z.string().nullish(),
          }),
        )
        .nullish(),
    })
    .nullish(),
});

const historicalPriceSchema = z.looseObject({
  success: z.boolean().nullish(),
  data: z.looseObject({ value: z.number().nullish() }).nullish(),
});

const priceSeriesSchema = z.looseObject({
  success: z.boolean().nullish(),
  data: z
    .looseObject({
      items: z
        .array(
          z.looseObject({
            unixTime: z.number().nullish(),
            value: z.number().nullish(),
          }),
        )
        .nullish(),
    })
    .nullish(),
});

const netWorthSchema = z.looseObject({
  data: z
    .looseObject({
      history: z
        .array(
          z.looseObject({
            timestamp: z.string().nullish(),
            net_worth: z.number().nullish(),
          }),
        )
        .nullish(),
    })
    .nullish(),
});

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
  const data = await fetchJSON(
    `https://public-api.birdeye.so/v1/wallet/token_list?wallet=${wallet}`,
    {
      vendor: "birdeye",
      schema: tokenListSchema,
      init: { headers: birdeyeHeaders() },
    },
  );
  const items: TokenListItem[] = (data.data?.items || []).map((t) => ({
    address: t.address,
    symbol: t.symbol ?? undefined,
    name: t.name ?? undefined,
    uiAmount: t.uiAmount ?? undefined,
    priceUsd: t.priceUsd ?? undefined,
    logoURI: t.logoURI ?? undefined,
  }));
  return items;
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

export async function getHistoricalPrice(
  mint: string,
  unixTs: number,
): Promise<number | null> {
  if (!unixTs || unixTs <= 0) return null;
  const dayTs = Math.floor(unixTs / 86400) * 86400;
  const key = `${mint}:${dayTs}`;
  const cached = histPriceCache.get(key);
  if (cached !== undefined) return cached;
  try {
    const data = await fetchJSON(
      `https://public-api.birdeye.so/defi/historical_price_unix?address=${mint}&unixtime=${dayTs}`,
      {
        vendor: "birdeye",
        schema: historicalPriceSchema,
        init: { headers: birdeyeHeaders() },
      },
    );
    if (data?.success && typeof data.data?.value === "number") {
      const price = data.data.value;
      histPriceCache.set(key, price);
      return price;
    }
    return null;
  } catch (e) {
    console.error(
      `portfolio: Birdeye historical price failed for ${mint.slice(0, 4)}…@${dayTs}: ${(e as Error).message}`,
    );
    return null;
  }
}

const SERIES_CHUNK_DAYS = 800;

export async function getPriceSeries(
  mint: string,
  fromTs: number,
  toTs: number,
): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  for (let from = fromTs; from <= toTs; from += SERIES_CHUNK_DAYS * 86_400) {
    const to = Math.min(from + SERIES_CHUNK_DAYS * 86_400 - 1, toTs);
    try {
      const data = await fetchJSON(
        `https://public-api.birdeye.so/defi/history_price?address=${mint}&address_type=token&type=1D&time_from=${from}&time_to=${to}`,
        {
          vendor: "birdeye",
          schema: priceSeriesSchema,
          init: { headers: birdeyeHeaders() },
        },
      );
      for (const item of data?.data?.items || []) {
        if (
          typeof item.unixTime === "number" &&
          typeof item.value === "number" &&
          item.value > 0
        ) {
          out.set(Math.floor(item.unixTime / 86_400) * 86_400, item.value);
        }
      }
    } catch (e) {
      console.error(
        `portfolio: Birdeye price series failed for ${mint.slice(0, 4)}…: ${(e as Error).message}`,
      );
    }
  }
  return out;
}

const NET_WORTH_MAX_DAYS = 90;

export async function getNetWorthHistory(
  wallet: string,
): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  try {
    const data = await fetchJSON(
      `https://public-api.birdeye.so/wallet/v2/net-worth?wallet=${wallet}&count=${NET_WORTH_MAX_DAYS}&direction=back&type=1d`,
      {
        vendor: "birdeye",
        schema: netWorthSchema,
        init: { headers: birdeyeHeaders() },
      },
    );
    const today = Math.floor(Date.now() / 1000 / 86_400) * 86_400;
    for (const row of data?.data?.history || []) {
      if (!row.timestamp || typeof row.net_worth !== "number") continue;
      const ts = Math.floor(Date.parse(row.timestamp) / 1000);
      if (!Number.isFinite(ts)) continue;
      const day = Math.floor(ts / 86_400) * 86_400;
      if (day >= today) continue;
      if (!out.has(day)) out.set(day, row.net_worth);
    }
  } catch (e) {
    console.error(
      `portfolio: Birdeye net-worth history failed for ${wallet.slice(0, 4)}…: ${(e as Error).message}`,
    );
  }
  return out;
}

export async function getTokenMeta(
  mint: string,
): Promise<{ symbol: string; icon?: string } | null> {
  const cached = tokenMetaCache.get(mint);
  if (cached) return cached;
  try {
    const data = await fetchJSON(
      `https://public-api.birdeye.so/defi/v3/token/meta-data/single?address=${mint}`,
      {
        vendor: "birdeye",
        schema: tokenMetaSchema,
        init: { headers: birdeyeHeaders() },
      },
    );
    if (data?.success && data.data?.symbol) {
      const meta: { symbol: string; icon?: string } = {
        symbol: data.data.symbol,
        ...(data.data.logo_uri ? { icon: data.data.logo_uri } : {}),
      };
      tokenMetaCache.set(mint, meta);
      return meta;
    }
    return null;
  } catch {
    return null;
  }
}
