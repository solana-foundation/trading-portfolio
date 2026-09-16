import { createHash } from "node:crypto";
import {
  getHistoricalPrice,
  getHoldings,
  getTokenMeta,
} from "@/lib/portfolio/birdeye";
import { TtlCache } from "@/lib/portfolio/cache";
import { fetchTransactions } from "@/lib/portfolio/tx-provider";
import {
  aggregateSwapEvents,
  SOL_MINT,
  STABLECOIN_MINTS,
  synthesizeSwapFromTransfers,
} from "@/lib/portfolio/swaps";
import type { HeliusTx } from "@/lib/portfolio/swaps";
import type {
  Holdings,
  TradeHistoryRow,
  TradePnLResult,
  TradePnLRow,
  TradePnLSummary,
} from "@/lib/portfolio/types";
import { computeXIRR, type Cashflow } from "@/lib/portfolio/xirr";

const resultCache = new TtlCache<TradePnLResult>(500, 5 * 60 * 1000);

export function tradeSortKey(t: TradeHistoryRow): string {
  return [t.signature || "", t.kind, t.wallet, t.mint].join("|");
}

const TRANSFER_ALLOWED_TX_TYPES = new Set(["TRANSFER", "SWAP", "UNKNOWN"]);
const XIRR_MIN_WINDOW_SECONDS = 7 * 86400;

function deriveSolPriceFromHoldings(holdingsList: Holdings[]): number {
  for (const h of holdingsList) {
    const sol = (h.tokens || []).find(
      (t) => t.address === SOL_MINT || t.symbol === "SOL",
    );
    if (sol?.price) return sol.price;
  }
  return 0;
}

function isExcludedMint(mint: string): boolean {
  return STABLECOIN_MINTS.has(mint);
}

const COVERAGE_TOLERANCE = 1 + 1e-6;

export function coveredCostBasis(
  balance: number,
  totalSpent: number,
  totalBought: number,
  poolLimit = Number.POSITIVE_INFINITY,
): { coveredAmount: number; avgCostPerToken: number; costBasis: number } {
  if (totalSpent <= 0 || totalBought <= 0 || balance <= 0 || poolLimit <= 0) {
    return { coveredAmount: 0, avgCostPerToken: 0, costBasis: 0 };
  }
  const avgCostPerToken = totalSpent / totalBought;
  const coveredAmount = Math.min(balance, totalBought, poolLimit);
  return {
    coveredAmount,
    avgCostPerToken,
    costBasis: coveredAmount * avgCostPerToken,
  };
}

type MintAcc = {
  totalSpent: number;
  totalBought: number;
  totalHeld: number;
  txCount: number;
  sources: Set<string>;
  symbol?: string;
  name?: string;
  icon?: string;
  price?: number;
};
type WalletMintAcc = {
  totalSpent: number;
  totalBought: number;
  txCount: number;
  sources: Set<string>;
};
type TransferEvent = {
  mint: string;
  amount: number;
  ts: number;
  wallet: string;
  signature: string | null;
  fromAccount: string | null;
};

export async function getPortfolioHoldings(
  wallets: string[],
): Promise<Holdings[]> {
  return Promise.all(wallets.map((w) => getHoldings(w)));
}

export async function getAggregateTradePnL(
  wallets: string[],
  holdings: Holdings[],
  netWorthUsd?: number,
): Promise<TradePnLResult> {
  const holdingsFp = createHash("sha1")
    .update(
      JSON.stringify(
        holdings.map((h) =>
          (h.tokens || []).map((t) => [t.address, t.balance, t.price]),
        ),
      ),
    )
    .digest("hex");
  const cacheKey = `${[...wallets].sort().join(",")}:${holdingsFp}`;
  const cached = resultCache.get(cacheKey);
  if (cached) return cached;

  const txFetches = await Promise.all(
    wallets.map((w) => fetchTransactions(w)),
  );
  const txsPerWallet = txFetches.map((f) => f.txs);
  const historyTruncated = txFetches.some((f) => f.truncated);
  const householdSet = new Set(wallets);

  const currentSolPrice =
    deriveSolPriceFromHoldings(holdings) ||
    (await getHistoricalPrice(SOL_MINT, Math.floor(Date.now() / 1000))) ||
    0;
  const swapDays = new Set<number>();
  for (const txs of txsPerWallet) {
    for (const tx of txs) {
      if (!tx.timestamp) continue;
      if (tx.events?.swap || tx.type === "SWAP") {
        swapDays.add(Math.floor(tx.timestamp / 86400) * 86400);
      }
    }
  }
  const solPriceByDay = new Map<number, number>();
  await Promise.all(
    Array.from(swapDays).map(async (day) => {
      const p = await getHistoricalPrice(SOL_MINT, day);
      if (p && p > 0) solPriceByDay.set(day, p);
    }),
  );
  const todayDay = Math.floor(Date.now() / 1000 / 86400) * 86400;
  let solPriceFellBack = false;
  const solPriceAt = (ts: number) => {
    const day = Math.floor((ts || 0) / 86400) * 86400;
    const p = solPriceByDay.get(day);
    if (p) return p;
    if (day === todayDay) return currentSolPrice;
    solPriceFellBack = true;
    return 0;
  };
  const solPriceUsd = currentSolPrice;

  const swapEventsPerWallet = txsPerWallet.map((txs, i) =>
    aggregateSwapEvents(wallets[i], txs, solPriceAt),
  );
  const accsPerWallet = swapEventsPerWallet.map((x) => x.buys);

  const byMint = new Map<string, MintAcc>();
  const perWalletByMint = wallets.map(() => new Map<string, WalletMintAcc>());
  let hasUnpriced =
    swapEventsPerWallet.some((x) => x.unpricedSwaps > 0) ||
    solPriceFellBack ||
    holdings.some((h) => (h?.unpricedCount || 0) > 0);

  function bumpMint(
    mint: string,
    deltaSpent: number,
    deltaBought: number,
    deltaTxs: number,
    source: string,
  ): MintAcc {
    let m = byMint.get(mint);
    if (!m) {
      m = {
        totalSpent: 0,
        totalBought: 0,
        totalHeld: 0,
        txCount: 0,
        sources: new Set(),
      };
      byMint.set(mint, m);
    }
    m.totalSpent += deltaSpent;
    m.totalBought += deltaBought;
    m.txCount += deltaTxs;
    if (source) m.sources.add(source);
    return m;
  }
  function bumpWalletMint(
    i: number,
    mint: string,
    deltaSpent: number,
    deltaBought: number,
    deltaTxs: number,
    source: string,
  ): WalletMintAcc {
    const wmap = perWalletByMint[i];
    let m = wmap.get(mint);
    if (!m) {
      m = { totalSpent: 0, totalBought: 0, txCount: 0, sources: new Set() };
      wmap.set(mint, m);
    }
    m.totalSpent += deltaSpent;
    m.totalBought += deltaBought;
    m.txCount += deltaTxs;
    if (source) m.sources.add(source);
    return m;
  }

  for (let i = 0; i < wallets.length; i++) {
    for (const [mint, entry] of accsPerWallet[i].entries()) {
      if (isExcludedMint(mint)) continue;
      if (entry.totalCostUsd <= 0) {
        hasUnpriced = true;
        continue;
      }
      bumpMint(mint, entry.totalCostUsd, entry.amountBought, entry.txCount, "swap");
      bumpWalletMint(i, mint, entry.totalCostUsd, entry.amountBought, entry.txCount, "swap");
    }
  }

  const heldMintsPerWallet = wallets.map(() => new Set<string>());
  for (let i = 0; i < wallets.length; i++) {
    for (const t of holdings[i]?.tokens || []) {
      if (t.hidden) continue;
      if (isExcludedMint(t.address)) continue;
      if ((t.balance || 0) > 0) heldMintsPerWallet[i].add(t.address);

      let m = byMint.get(t.address);
      if (!m) {
        m = {
          totalSpent: 0,
          totalBought: 0,
          totalHeld: 0,
          txCount: 0,
          sources: new Set(),
        };
        byMint.set(t.address, m);
      }
      m.totalHeld += t.balance || 0;
      if (!m.symbol) {
        m.symbol = t.symbol;
        m.name = t.name;
        m.icon = t.icon;
      }
      if (!m.price && t.price) m.price = t.price;
    }
  }

  const transferEvents: TransferEvent[] = [];
  for (let i = 0; i < wallets.length; i++) {
    const w = wallets[i];
    const heldMints = heldMintsPerWallet[i];
    for (const tx of txsPerWallet[i]) {
      if (tx.type && !TRANSFER_ALLOWED_TX_TYPES.has(tx.type)) continue;
      const swap = tx?.events?.swap || synthesizeSwapFromTransfers(tx, w);
      const userIsSwapInput =
        swap &&
        (swap.nativeInput?.account === w ||
          (swap.tokenInputs || []).some((x) => x.userAccount === w));
      if (userIsSwapInput) continue;
      for (const tt of tx.tokenTransfers || []) {
        if (tt.toUserAccount !== w) continue;
        const mint = tt.mint;
        if (!mint) continue;
        if (isExcludedMint(mint)) continue;
        if (!heldMints.has(mint)) continue;
        if (tt.fromUserAccount && householdSet.has(tt.fromUserAccount)) continue;
        const amount = Number.parseFloat(String(tt.tokenAmount ?? 0)) || 0;
        if (amount <= 0) continue;
        transferEvents.push({
          mint,
          amount,
          ts: tx.timestamp || 0,
          wallet: w,
          signature: tx.signature || null,
          fromAccount: tt.fromUserAccount || null,
        });
      }
    }
  }

  const uniqueQueries = new Map<string, { mint: string; ts: number }>();
  for (const ev of transferEvents) {
    const day = Math.floor((ev.ts || 0) / 86400) * 86400;
    if (!day) continue;
    const key = `${ev.mint}:${day}`;
    if (!uniqueQueries.has(key)) uniqueQueries.set(key, { mint: ev.mint, ts: day });
  }
  const priceLookups = await Promise.all(
    Array.from(uniqueQueries.entries()).map(async ([key, q]) => {
      const price = await getHistoricalPrice(q.mint, q.ts);
      return [key, price] as const;
    }),
  );
  const priceMap = new Map<string, number | null>(priceLookups);

  for (const ev of transferEvents) {
    const day = Math.floor((ev.ts || 0) / 86400) * 86400;
    const price = priceMap.get(`${ev.mint}:${day}`);
    if (!price || price <= 0) {
      hasUnpriced = true;
      continue;
    }
    const cost = ev.amount * price;
    bumpMint(ev.mint, cost, ev.amount, 1, "transfer");
    const wIdx = wallets.indexOf(ev.wallet);
    if (wIdx !== -1) bumpWalletMint(wIdx, ev.mint, cost, ev.amount, 1, "transfer");
  }

  await Promise.all(
    Array.from(byMint.entries())
      .filter(([, m]) => m.totalSpent > 0 && !m.symbol)
      .map(async ([mint, m]) => {
        const meta = await getTokenMeta(mint);
        if (meta) {
          m.symbol = meta.symbol;
          if (!m.icon) m.icon = meta.icon;
        }
      }),
  );

  const perWallet: Record<string, TradePnLRow[]> = {};
  let totalPnL = 0;
  let totalCostBasis = 0;
  let totalValue = 0;

  const boughtPool = new Map<string, number>();
  for (const [mint, m] of byMint.entries()) boughtPool.set(mint, m.totalBought);
  for (let i = 0; i < wallets.length; i++) {
    for (const t of holdings[i]?.tokens || []) {
      const bal = t.balance || 0;
      if (bal <= 0 || isExcludedMint(t.address)) continue;
      if (t.hidden) continue;
      const own = perWalletByMint[i].get(t.address);
      if (!own || own.totalSpent <= 0 || own.totalBought <= 0) continue;
      const reserved = coveredCostBasis(
        bal,
        own.totalSpent,
        own.totalBought,
      ).coveredAmount;
      boughtPool.set(
        t.address,
        Math.max(0, (boughtPool.get(t.address) ?? 0) - reserved),
      );
    }
  }
  const walletOrder = wallets
    .map((_, i) => i)
    .sort((a, b) => wallets[a].localeCompare(wallets[b]));

  for (const i of walletOrder) {
    const w = wallets[i];
    const rows: TradePnLRow[] = [];
    for (const t of holdings[i]?.tokens || []) {
      if (t.hidden) continue;
      const bal = t.balance || 0;
      if (bal <= 0) continue;

      const hh = byMint.get(t.address);
      totalValue += bal * (t.price || hh?.price || 0);
      if (isExcludedMint(t.address)) continue;

      const own = perWalletByMint[i].get(t.address);

      const ownUsable = own && own.totalSpent > 0 && own.totalBought > 0;
      const hhUsable = hh && hh.totalSpent > 0 && hh.totalBought > 0;
      if (!ownUsable && !hhUsable) {
        hasUnpriced = true;
        continue;
      }

      const ownPart = ownUsable
        ? coveredCostBasis(bal, own!.totalSpent, own!.totalBought)
        : { coveredAmount: 0, avgCostPerToken: 0, costBasis: 0 };
      const poolLeft = Math.max(0, boughtPool.get(t.address) ?? 0);
      const hhPart = hhUsable
        ? coveredCostBasis(
            bal - ownPart.coveredAmount,
            hh!.totalSpent,
            hh!.totalBought,
            poolLeft,
          )
        : { coveredAmount: 0, avgCostPerToken: 0, costBasis: 0 };
      const coveredAmount = ownPart.coveredAmount + hhPart.coveredAmount;
      if (bal > coveredAmount * COVERAGE_TOLERANCE) hasUnpriced = true;
      if (coveredAmount <= 0) continue;
      if (hhPart.coveredAmount > 0) {
        boughtPool.set(t.address, poolLeft - hhPart.coveredAmount);
      }
      const costBasis = ownPart.costBasis + hhPart.costBasis;
      const attribution: "wallet" | "household" =
        hhPart.coveredAmount > 0 ? "household" : "wallet";
      const sourcesSet =
        hhPart.coveredAmount > 0 ? hh!.sources : own!.sources;
      const perTokenCost = costBasis / coveredAmount;
      const currentPrice = t.price || hh?.price || 0;
      const currentValue = bal * currentPrice;
      const amountSpent = costBasis;
      const pnl = coveredAmount * currentPrice - costBasis;
      const pnlPercent = costBasis > 0 ? (pnl / costBasis) * 100 : 0;

      rows.push({
        mint: t.address,
        symbol: t.symbol || hh?.symbol,
        name: t.name || hh?.name,
        icon: t.icon || hh?.icon,
        currentAmount: bal,
        currentPrice,
        currentValue,
        costBasis: amountSpent,
        avgCostPerToken: perTokenCost,
        pnl,
        pnlPercent,
        householdSpent: hh ? hh.totalSpent : null,
        householdBought: hh ? hh.totalBought : null,
        householdHeld: hh ? hh.totalHeld : null,
        txCount: own ? own.txCount : hh ? hh.txCount : 0,
        costSource: Array.from(sourcesSet).sort().join("+") || "unknown",
        attribution,
      });

      totalPnL += pnl;
      totalCostBasis += amountSpent;
    }
    perWallet[w] = rows;
  }

  type ExternalEvent = {
    mint: string;
    amount: number;
    ts: number;
    dir: "in" | "out";
  };
  const externalEvents: ExternalEvent[] = [];
  for (let i = 0; i < wallets.length; i++) {
    const w = wallets[i];
    for (const tx of txsPerWallet[i]) {
      if (tx.type && tx.type !== "TRANSFER") continue;
      const ts = tx.timestamp || 0;
      for (const tt of tx.tokenTransfers || []) {
        const amt = Number.parseFloat(String(tt.tokenAmount ?? 0)) || 0;
        if (amt <= 0 || !tt.mint) continue;
        if (
          tt.toUserAccount === w &&
          tt.fromUserAccount &&
          !householdSet.has(tt.fromUserAccount)
        ) {
          externalEvents.push({ mint: tt.mint, amount: amt, ts, dir: "in" });
        } else if (
          tt.fromUserAccount === w &&
          tt.toUserAccount &&
          !householdSet.has(tt.toUserAccount)
        ) {
          externalEvents.push({ mint: tt.mint, amount: amt, ts, dir: "out" });
        }
      }
      for (const nt of tx.nativeTransfers || []) {
        const lam = Number.parseFloat(String(nt.amount ?? 0)) || 0;
        const sol = lam / 1e9;
        if (sol <= 0) continue;
        if (
          nt.toUserAccount === w &&
          nt.fromUserAccount &&
          !householdSet.has(nt.fromUserAccount)
        ) {
          externalEvents.push({ mint: SOL_MINT, amount: sol, ts, dir: "in" });
        } else if (
          nt.fromUserAccount === w &&
          nt.toUserAccount &&
          !householdSet.has(nt.toUserAccount)
        ) {
          externalEvents.push({ mint: SOL_MINT, amount: sol, ts, dir: "out" });
        }
      }
    }
  }

  const extPriceQueries = new Map<string, { mint: string; ts: number }>();
  for (const ev of externalEvents) {
    if (STABLECOIN_MINTS.has(ev.mint) || !ev.ts) continue;
    const day = Math.floor(ev.ts / 86400) * 86400;
    const key = `${ev.mint}:${day}`;
    if (!extPriceQueries.has(key)) extPriceQueries.set(key, { mint: ev.mint, ts: day });
  }
  const extPriceLookups = await Promise.all(
    Array.from(extPriceQueries.entries()).map(
      async ([key, q]) => [key, await getHistoricalPrice(q.mint, q.ts)] as const,
    ),
  );
  const extPriceMap = new Map<string, number | null>(extPriceLookups);

  const cashflowEvents: Cashflow[] = [];
  let unpricedCashflowCount = 0;
  for (const ev of externalEvents) {
    let usd = 0;
    if (STABLECOIN_MINTS.has(ev.mint)) {
      usd = ev.amount;
    } else {
      const day = Math.floor(ev.ts / 86400) * 86400;
      const p = extPriceMap.get(`${ev.mint}:${day}`);
      if (!p || p <= 0) {
        unpricedCashflowCount += 1;
        hasUnpriced = true;
        continue;
      }
      usd = ev.amount * p;
    }
    if (usd <= 0) continue;
    cashflowEvents.push({ ts: ev.ts, amount: ev.dir === "in" ? -usd : usd });
  }

  const investedDisplay = totalCostBasis;
  const investedGross = cashflowEvents.reduce(
    (s, c) => s + (c.amount < 0 ? -c.amount : 0),
    0,
  );
  const realizedReceipts = cashflowEvents.reduce(
    (s, c) => s + (c.amount > 0 ? c.amount : 0),
    0,
  );
  const absoluteReturnUsd = totalPnL;
  const absoluteReturnPct =
    totalCostBasis > 0 ? (totalPnL / totalCostBasis) * 100 : null;

  const nowTs = Math.floor(Date.now() / 1000);
  const firstCashflowTs = cashflowEvents.reduce(
    (min, c) => Math.min(min, c.ts),
    nowTs,
  );
  const xirrReliable =
    !historyTruncated && nowTs - firstCashflowTs >= XIRR_MIN_WINDOW_SECONDS;
  const terminalValue = netWorthUsd ?? totalValue;
  const xirrRate = xirrReliable
    ? computeXIRR([...cashflowEvents, { ts: nowTs, amount: terminalValue }])
    : null;
  const xirrPct = xirrRate != null ? xirrRate * 100 : null;

  let benchmarkSolXirrPct: number | null = null;
  if (xirrReliable && cashflowEvents.length > 0 && solPriceUsd > 0) {
    const solQueries = new Set(
      cashflowEvents.map((c) => Math.floor(c.ts / 86400) * 86400),
    );
    const benchSolPriceByDay = new Map<number, number>();
    await Promise.all(
      Array.from(solQueries).map(async (day) => {
        const p = await getHistoricalPrice(SOL_MINT, day);
        if (p && p > 0) benchSolPriceByDay.set(day, p);
      }),
    );
    let netSol = 0;
    const bcfs: Cashflow[] = [];
    for (const c of cashflowEvents) {
      const day = Math.floor(c.ts / 86400) * 86400;
      const sp = benchSolPriceByDay.get(day) || solPriceUsd;
      if (sp <= 0) continue;
      netSol += -c.amount / sp;
      bcfs.push(c);
    }
    if (bcfs.length > 0) {
      const benchValueToday = netSol * solPriceUsd;
      const benchXirr = computeXIRR([
        ...bcfs,
        { ts: nowTs, amount: benchValueToday },
      ]);
      if (benchXirr != null) benchmarkSolXirrPct = benchXirr * 100;
    }
  }

  const summary: TradePnLSummary = {
    currentValue: totalValue,
    investedTotal: investedDisplay,
    investedGross,
    realizedReceipts,
    absoluteReturnUsd,
    absoluteReturnPct,
    xirrPct,
    benchmarkSolXirrPct,
    cashflowCount: cashflowEvents.length,
    unpricedCashflowCount,
  };

  const symbolFor = (mint: string): string | null => {
    const m = byMint.get(mint);
    if (m?.symbol) return m.symbol;
    for (const h of holdings) {
      for (const t of h?.tokens || []) {
        if (t.address === mint && t.symbol) return t.symbol;
      }
    }
    return null;
  };

  const tradeHistory: TradeHistoryRow[] = [];
  for (let i = 0; i < wallets.length; i++) {
    const w = wallets[i];
    const walletShort = `${w.slice(0, 4)}…${w.slice(-4)}`;
    for (const ev of swapEventsPerWallet[i].events) {
      if (isExcludedMint(ev.mint)) continue;
      if (!ev.usd || ev.usd <= 0) continue;
      tradeHistory.push({
        kind: ev.kind,
        side: ev.kind === "buy_swap" ? "buy" : "sell",
        wallet: w,
        walletShort,
        mint: ev.mint,
        symbol: symbolFor(ev.mint),
        amount: ev.amount,
        usd: ev.usd,
        ts: ev.ts,
        signature: ev.signature,
        source: ev.source,
        fromExternal: false,
      });
    }
  }
  for (const ev of transferEvents) {
    if (isExcludedMint(ev.mint)) continue;
    const day = Math.floor((ev.ts || 0) / 86400) * 86400;
    const price = priceMap.get(`${ev.mint}:${day}`);
    if (!price || price <= 0) continue;
    const usd = ev.amount * price;
    const w = ev.wallet;
    const walletShort = `${w.slice(0, 4)}…${w.slice(-4)}`;
    tradeHistory.push({
      kind: "buy_transfer",
      side: "buy",
      wallet: w,
      walletShort,
      mint: ev.mint,
      symbol: symbolFor(ev.mint),
      amount: ev.amount,
      usd,
      ts: ev.ts,
      signature: ev.signature,
      source: "TRANSFER",
      fromExternal: true,
      fromAccount: ev.fromAccount,
    });
  }
  tradeHistory.sort(
    (a, b) =>
      (b.ts || 0) - (a.ts || 0) ||
      tradeSortKey(a).localeCompare(tradeSortKey(b)),
  );

  const mintCosts = Array.from(byMint.entries())
    .filter(([, m]) => m.totalSpent > 0 && m.totalBought > 0)
    .map(([mint, m]) => ({
      mint,
      symbol: m.symbol || null,
      avgCostPerToken: m.totalSpent / m.totalBought,
    }));

  const result: TradePnLResult = {
    perWallet,
    mintCosts,
    totals: { totalPnL, totalCostBasis, totalValue },
    summary,
    tradeHistory,
    solPriceUsd,
    walletsScanned: wallets.length,
    hasUnpriced,
    historyTruncated,
  };
  resultCache.set(cacheKey, result);
  return result;
}

export type { HeliusTx };
