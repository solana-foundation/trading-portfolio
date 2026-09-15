import { TtlCache } from "@/lib/portfolio/cache";
import { fetchJSON } from "@/lib/portfolio/fetch-json";
import { SOL_MINT } from "@/lib/portfolio/swaps";
import type { Holdings, TokenHolding } from "@/lib/portfolio/types";

const NATIVE_SOL = "11111111111111111111111111111111";

const CANONICAL_MINTS: Record<string, string> = {
  USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  USDT: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  PYUSD: "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo",
  SOL: SOL_MINT,
};

const DUST_THRESHOLD_USD = 0.01;

const holdingsCache = new TtlCache<Holdings>(1_000, 2 * 60 * 1000);
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

type BirdeyeHoldingsResp = {
  data?: {
    items?: Array<{
      symbol?: string;
      name?: string;
      uiAmount?: number;
      priceUsd?: number;
      logoURI?: string;
      address: string;
    }>;
  };
};

export async function getHoldings(wallet: string): Promise<Holdings> {
  const cached = holdingsCache.get(wallet);
  if (cached) return cached;

  const data = await fetchJSON<BirdeyeHoldingsResp>(
    `https://public-api.birdeye.so/v1/wallet/token_list?wallet=${wallet}`,
    { headers: birdeyeHeaders() },
  );

  if (!data.data?.items) return { tokens: [], totalValue: 0 };

  const tokens: TokenHolding[] = data.data.items
    .map((t) => ({
      symbol: t.symbol,
      name: t.name,
      balance: t.uiAmount || 0,
      price: t.priceUsd || 0,
      value: (t.uiAmount || 0) * (t.priceUsd || 0),
      icon: t.logoURI,
      address: t.address === NATIVE_SOL ? SOL_MINT : t.address,
    }))
    .filter((t) => t.value > DUST_THRESHOLD_USD)
    .filter((t) => {
      const canonical = CANONICAL_MINTS[(t.symbol || "").toUpperCase()];
      return !canonical || canonical === t.address;
    })
    .sort((a, b) => b.value - a.value);

  const holdings: Holdings = {
    tokens,
    totalValue: tokens.reduce((s, t) => s + t.value, 0),
  };
  holdingsCache.set(wallet, holdings);
  return holdings;
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
    type Resp = { success?: boolean; data?: { value?: number } };
    const data = await fetchJSON<Resp>(
      `https://public-api.birdeye.so/defi/historical_price_unix?address=${mint}&unixtime=${dayTs}`,
      { headers: birdeyeHeaders() },
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

export async function getTokenMeta(
  mint: string,
): Promise<{ symbol: string; icon?: string } | null> {
  const cached = tokenMetaCache.get(mint);
  if (cached) return cached;
  try {
    type Resp = {
      success?: boolean;
      data?: { symbol?: string; logo_uri?: string };
    };
    const data = await fetchJSON<Resp>(
      `https://public-api.birdeye.so/defi/v3/token/meta-data/single?address=${mint}`,
      { headers: birdeyeHeaders() },
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
