import { TtlCache } from "@/lib/portfolio/cache";
import { fetchJSON } from "@/lib/portfolio/fetch-json";
import type { HeliusTx } from "@/lib/portfolio/swaps";

const PAGE_SIZE = 100;
const DEFAULT_MAX_PAGES = 20;

const txCache = new TtlCache<HeliusTx[]>(1_000, 60 * 60 * 1000);

export class HeliusAuthError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "HeliusAuthError";
  }
}

type HeliusErrorResp = { error?: { code?: number; message?: string } };

export async function fetchTransactions(
  wallet: string,
  maxPages = DEFAULT_MAX_PAGES,
): Promise<HeliusTx[]> {
  const cached = txCache.get(wallet);
  if (cached) return cached;

  const apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey) throw new HeliusAuthError("HELIUS_API_KEY is not set");

  const all: HeliusTx[] = [];
  let before: string | null = null;
  for (let i = 0; i < maxPages; i++) {
    const url: string =
      `https://api.helius.xyz/v0/addresses/${wallet}/transactions` +
      `?api-key=${apiKey}&limit=${PAGE_SIZE}` +
      (before ? `&before=${before}` : "");
    let page: HeliusTx[] | HeliusErrorResp;
    try {
      page = await fetchJSON(url);
    } catch (e) {
      throw new Error(
        `Helius fetch failed for ${wallet.slice(0, 4)}…: ${(e as Error).message}`,
      );
    }
    if (page && !Array.isArray(page) && (page as HeliusErrorResp).error) {
      const errResp = page as HeliusErrorResp;
      const msg = errResp.error?.message || JSON.stringify(errResp.error);
      if (errResp.error?.code === -32401 || /invalid api key/i.test(msg)) {
        throw new HeliusAuthError(msg);
      }
      throw new Error(`Helius API error for ${wallet.slice(0, 4)}…: ${msg}`);
    }
    if (!Array.isArray(page) || page.length === 0) break;
    all.push(...page);
    if (page.length < PAGE_SIZE) break;
    before = page[page.length - 1]?.signature ?? null;
    if (!before) break;
  }
  txCache.set(wallet, all);
  return all;
}
