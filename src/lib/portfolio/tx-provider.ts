import { TtlCache } from "@/lib/portfolio/cache";
import { fetchJSON } from "@/lib/portfolio/fetch-json";
import type { HeliusTx } from "@/lib/portfolio/swaps";

const PAGE_SIZE = 100;
const DEFAULT_MAX_PAGES = 20;
const MAX_TOKEN_ACCOUNTS = 32;
const ACCOUNT_FETCH_CONCURRENCY = 8;

const TOKEN_PROGRAM_IDS = [
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
];

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

async function fetchForAddress(
  address: string,
  maxPages: number,
): Promise<TxFetchResult> {
  const configured = PROVIDERS.filter((p) => p.pageUrl(address, null) !== null);
  if (configured.length === 0) {
    throw new ProviderAuthError(
      "No transaction provider configured (set HELIUS_API_KEY or TRITON_API_URL)",
    );
  }

  const failures: string[] = [];
  let allAuthFailures = true;
  for (const provider of configured) {
    try {
      return await fetchFromProvider(provider, address, maxPages);
    } catch (e) {
      if (!(e instanceof ProviderAuthError)) allAuthFailures = false;
      failures.push((e as Error).message);
    }
  }
  const summary = failures.join("; ");
  if (allAuthFailures) throw new ProviderAuthError(summary);
  throw new Error(`All transaction providers failed: ${summary}`);
}

type RpcTokenAccountsResp = {
  result?: { value?: Array<{ pubkey?: string }> };
  error?: { code?: number; message?: string };
};

async function getTokenAccounts(wallet: string): Promise<string[]> {
  const apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey) return [];
  const url = `https://mainnet.helius-rpc.com/?api-key=${apiKey}`;
  const out: string[] = [];
  for (const programId of TOKEN_PROGRAM_IDS) {
    const resp = await fetchJSON<RpcTokenAccountsResp>(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getTokenAccountsByOwner",
        params: [wallet, { programId }, { encoding: "jsonParsed" }],
      }),
    });
    if (resp.error) {
      const msg = resp.error.message || JSON.stringify(resp.error);
      if (isAuthError(resp.error.code, msg)) {
        throw new ProviderAuthError(`helius rpc: ${msg}`);
      }
      throw new Error(
        `helius rpc getTokenAccountsByOwner failed for ${wallet.slice(0, 4)}…: ${msg}`,
      );
    }
    for (const v of resp.result?.value || []) {
      if (v.pubkey) out.push(v.pubkey);
    }
  }
  return out;
}

async function fetchAddressesBounded(
  addresses: string[],
  maxPages: number,
): Promise<TxFetchResult[]> {
  const results: TxFetchResult[] = new Array(addresses.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < addresses.length) {
      const i = next++;
      try {
        results[i] = await fetchForAddress(addresses[i], maxPages);
      } catch (e) {
        if (e instanceof ProviderAuthError) throw e;
        results[i] = await fetchForAddress(addresses[i], maxPages);
      }
    }
  }
  await Promise.all(
    Array.from(
      { length: Math.min(ACCOUNT_FETCH_CONCURRENCY, addresses.length) },
      () => worker(),
    ),
  );
  return results;
}

export async function fetchTransactions(
  wallet: string,
  maxPages = DEFAULT_MAX_PAGES,
): Promise<TxFetchResult> {
  const cached = txCache.get(wallet);
  if (cached) return cached;

  const owner = await fetchForAddress(wallet, maxPages);

  const accountsEnumerable = Boolean(process.env.HELIUS_API_KEY);
  const tokenAccounts = await getTokenAccounts(wallet);
  const capped = tokenAccounts.length > MAX_TOKEN_ACCOUNTS;
  const accountResults = await fetchAddressesBounded(
    tokenAccounts.slice(0, MAX_TOKEN_ACCOUNTS),
    maxPages,
  );

  const merged = new Map<string, HeliusTx>();
  const unsigned: HeliusTx[] = [];
  for (const tx of [owner, ...accountResults].flatMap((r) => r.txs)) {
    if (tx.signature) {
      if (!merged.has(tx.signature)) merged.set(tx.signature, tx);
    } else {
      unsigned.push(tx);
    }
  }
  const txs = [...merged.values(), ...unsigned].sort(
    (a, b) => (b.timestamp || 0) - (a.timestamp || 0),
  );

  const result: TxFetchResult = {
    txs,
    truncated:
      owner.truncated ||
      capped ||
      !accountsEnumerable ||
      accountResults.some((r) => r.truncated),
  };
  txCache.set(wallet, result);
  return result;
}
