import { TtlCache } from "@/lib/portfolio/cache";
import { fetchJSON } from "@/lib/portfolio/fetch-json";
import type { HeliusTx } from "@/lib/portfolio/swaps";

const PAGE_SIZE = 100;
const DEFAULT_MAX_PAGES = 20;

export type TxFetchResult = {
  txs: HeliusTx[];
  truncated: boolean;
};

const txCache = new TtlCache<TxFetchResult>(1_000, 60 * 60 * 1000);

export class ProviderAuthError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "ProviderAuthError";
  }
}

type ErrorResp = { error?: { code?: number; message?: string } };

type TxProvider = {
  name: string;
  pageUrl: (wallet: string, before: string | null) => string | null;
};

const PROVIDERS: TxProvider[] = [
  {
    name: "helius",
    pageUrl: (wallet, before) => {
      const apiKey = process.env.HELIUS_API_KEY;
      if (!apiKey) return null;
      return (
        `https://api.helius.xyz/v0/addresses/${wallet}/transactions` +
        `?api-key=${apiKey}&limit=${PAGE_SIZE}` +
        (before ? `&before=${before}` : "")
      );
    },
  },
  {
    name: "triton",
    pageUrl: (wallet, before) => {
      const base = process.env.TRITON_API_URL;
      if (!base) return null;
      return (
        `${base.replace(/\/$/, "")}/v0/addresses/${wallet}/transactions` +
        `?limit=${PAGE_SIZE}` +
        (before ? `&before=${before}` : "")
      );
    },
  },
];

function isAuthError(code: number | undefined, msg: string): boolean {
  return (
    code === -32401 || /invalid api key|unauthorized|forbidden/i.test(msg)
  );
}

async function fetchFromProvider(
  provider: TxProvider,
  wallet: string,
  maxPages: number,
): Promise<TxFetchResult> {
  const all: HeliusTx[] = [];
  let before: string | null = null;
  let truncated = true;
  for (let i = 0; i < maxPages; i++) {
    const url = provider.pageUrl(wallet, before);
    if (!url) throw new ProviderAuthError(`${provider.name} is not configured`);
    let page: HeliusTx[] | ErrorResp;
    try {
      page = await fetchJSON(url);
    } catch (e) {
      const msg = (e as Error).message;
      if (/HTTP (401|403)/.test(msg)) {
        throw new ProviderAuthError(`${provider.name}: ${msg}`);
      }
      throw new Error(
        `${provider.name} fetch failed for ${wallet.slice(0, 4)}…: ${msg}`,
      );
    }
    if (page && !Array.isArray(page) && (page as ErrorResp).error) {
      const errResp = page as ErrorResp;
      const msg = errResp.error?.message || JSON.stringify(errResp.error);
      if (isAuthError(errResp.error?.code, msg)) {
        throw new ProviderAuthError(`${provider.name}: ${msg}`);
      }
      throw new Error(
        `${provider.name} API error for ${wallet.slice(0, 4)}…: ${msg}`,
      );
    }
    if (!Array.isArray(page) || page.length === 0) {
      truncated = false;
      break;
    }
    all.push(...page);
    if (page.length < PAGE_SIZE) {
      truncated = false;
      break;
    }
    before = page[page.length - 1]?.signature ?? null;
    if (!before) {
      truncated = false;
      break;
    }
  }
  return { txs: all, truncated };
}

export async function fetchTransactions(
  wallet: string,
  maxPages = DEFAULT_MAX_PAGES,
): Promise<TxFetchResult> {
  const cached = txCache.get(wallet);
  if (cached) return cached;

  const configured = PROVIDERS.filter((p) => p.pageUrl(wallet, null) !== null);
  if (configured.length === 0) {
    throw new ProviderAuthError(
      "No transaction provider configured (set HELIUS_API_KEY or TRITON_API_URL)",
    );
  }

  const failures: string[] = [];
  let allAuthFailures = true;
  for (const provider of configured) {
    try {
      const result = await fetchFromProvider(provider, wallet, maxPages);
      txCache.set(wallet, result);
      return result;
    } catch (e) {
      if (!(e instanceof ProviderAuthError)) allAuthFailures = false;
      failures.push((e as Error).message);
    }
  }
  const summary = failures.join("; ");
  if (allAuthFailures) throw new ProviderAuthError(summary);
  throw new Error(`All transaction providers failed: ${summary}`);
}
