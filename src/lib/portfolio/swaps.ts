import type { BuyAggregate, CashEvent, SellAggregate } from "@/lib/portfolio/types";

export const STABLECOIN_MINTS = new Set([
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo",
]);
export const SOL_MINT = "So11111111111111111111111111111111111111112";

export type RawTokenAmount = { tokenAmount: string; decimals: number };
export type TokenSide = {
  userAccount?: string;
  mint: string;
  rawTokenAmount?: RawTokenAmount;
};
export type NativeSide = { account?: string; amount?: string };
export type SwapEvent = {
  nativeInput?: NativeSide | null;
  nativeOutput?: NativeSide | null;
  tokenInputs?: TokenSide[];
  tokenOutputs?: TokenSide[];
};
export type TokenTransfer = {
  fromUserAccount?: string;
  toUserAccount?: string;
  mint?: string;
  tokenAmount?: number | string;
};
export type NativeTransfer = {
  fromUserAccount?: string;
  toUserAccount?: string;
  amount?: number | string;
};
export type HeliusTx = {
  type?: string;
  timestamp?: number;
  signature?: string;
  source?: string;
  events?: { swap?: SwapEvent };
  tokenTransfers?: TokenTransfer[];
  nativeTransfers?: NativeTransfer[];
};

export type WalletSwapEvents = {
  buys: Map<string, BuyAggregate>;
  sells: Map<string, SellAggregate>;
  events: CashEvent[];
  unpricedSwaps: number;
};

export type SolPriceAt = (ts: number) => number;

function rawToFloat(rawTokenAmount: RawTokenAmount | undefined): number {
  if (!rawTokenAmount) return 0;
  const raw = Number.parseFloat(rawTokenAmount.tokenAmount);
  const decimals = Number(rawTokenAmount.decimals) || 0;
  if (!Number.isFinite(raw)) return 0;
  return raw / 10 ** decimals;
}

function cashMintUsd(mint: string, amount: number, solPriceUsd: number): number {
  if (STABLECOIN_MINTS.has(mint)) return amount;
  if (mint === SOL_MINT) return amount * (solPriceUsd || 0);
  return 0;
}

function distinctMints(tokens: Array<{ mint: string }>): number {
  return new Set(tokens.map((t) => t.mint)).size;
}

const FEE_THRESHOLD_LAMPORTS = 1_000_000;

export function synthesizeSwapFromTransfers(
  tx: HeliusTx,
  wallet: string,
): SwapEvent | null {
  if (!tx || tx.type !== "SWAP") return null;
  if (tx.events?.swap) return null;
  const synth: SwapEvent = {
    tokenInputs: [],
    tokenOutputs: [],
    nativeInput: null,
    nativeOutput: null,
  };

  for (const tt of tx.tokenTransfers || []) {
    const amt = Number.parseFloat(String(tt.tokenAmount ?? 0)) || 0;
    if (amt <= 0 || !tt.mint) continue;
    const fakeRaw: RawTokenAmount = { tokenAmount: String(amt), decimals: 0 };
    if (tt.fromUserAccount === wallet) {
      synth.tokenInputs?.push({
        userAccount: wallet,
        mint: tt.mint,
        rawTokenAmount: fakeRaw,
      });
    } else if (tt.toUserAccount === wallet) {
      synth.tokenOutputs?.push({
        userAccount: wallet,
        mint: tt.mint,
        rawTokenAmount: fakeRaw,
      });
    }
  }

  let solOut = 0;
  let solIn = 0;
  for (const nt of tx.nativeTransfers || []) {
    const lam = Number.parseFloat(String(nt.amount ?? 0)) || 0;
    if (lam <= 0) continue;
    if (nt.fromUserAccount === wallet) solOut += lam;
    else if (nt.toUserAccount === wallet) solIn += lam;
  }
  if (solOut >= FEE_THRESHOLD_LAMPORTS) {
    synth.nativeInput = { account: wallet, amount: String(solOut) };
  }
  if (solIn >= FEE_THRESHOLD_LAMPORTS) {
    synth.nativeOutput = { account: wallet, amount: String(solIn) };
  }

  const empty =
    (synth.tokenInputs?.length || 0) === 0 &&
    (synth.tokenOutputs?.length || 0) === 0 &&
    !synth.nativeInput &&
    !synth.nativeOutput;
  return empty ? null : synth;
}

export function aggregateSwapEvents(
  wallet: string,
  txs: HeliusTx[],
  solPriceAt: SolPriceAt,
): WalletSwapEvents {
  const buys = new Map<string, BuyAggregate>();
  const sells = new Map<string, SellAggregate>();
  const events: CashEvent[] = [];
  let unpricedSwaps = 0;

  for (const tx of txs) {
    const swap = tx?.events?.swap || synthesizeSwapFromTransfers(tx, wallet);
    if (!swap) continue;
    const ts = tx.timestamp || 0;
    const signature = tx.signature || null;
    const source = tx.source || null;
    const solPriceUsd = solPriceAt(ts);
    const cashUsd = (mint: string, amt: number) =>
      cashMintUsd(mint, amt, solPriceUsd);

    let cashInUsd = 0;
    const tokensOut: Array<{ mint: string; amount: number }> = [];
    let cashOutUsd = 0;
    const tokensIn: Array<{ mint: string; amount: number }> = [];

    if (swap.nativeInput?.account === wallet) {
      const lam = Number.parseFloat(swap.nativeInput.amount || "0") || 0;
      cashInUsd += (lam / 1e9) * (solPriceUsd || 0);
    }
    for (const input of swap.tokenInputs || []) {
      if (input.userAccount !== wallet) continue;
      const amt = rawToFloat(input.rawTokenAmount);
      if (amt <= 0) continue;
      const usd = cashUsd(input.mint, amt);
      if (usd > 0) cashInUsd += usd;
      else tokensOut.push({ mint: input.mint, amount: amt });
    }
    if (swap.nativeOutput?.account === wallet) {
      const lam = Number.parseFloat(swap.nativeOutput.amount || "0") || 0;
      cashOutUsd += (lam / 1e9) * (solPriceUsd || 0);
    }
    for (const output of swap.tokenOutputs || []) {
      if (output.userAccount !== wallet) continue;
      const amt = rawToFloat(output.rawTokenAmount);
      if (amt <= 0) continue;
      const usd = cashUsd(output.mint, amt);
      if (usd > 0) cashOutUsd += usd;
      else tokensIn.push({ mint: output.mint, amount: amt });
    }

    if (tokensIn.length > 0 && cashInUsd > 0 && distinctMints(tokensIn) > 1) {
      unpricedSwaps += 1;
    } else if (tokensIn.length > 0 && cashInUsd > 0) {
      const total = tokensIn.reduce((s, x) => s + x.amount, 0) || 1;
      for (const t of tokensIn) {
        const cost = cashInUsd * (t.amount / total);
        let acc = buys.get(t.mint);
        if (!acc) {
          acc = {
            amountBought: 0,
            totalCostUsd: 0,
            txCount: 0,
            firstTs: ts,
            lastTs: ts,
          };
          buys.set(t.mint, acc);
        }
        acc.amountBought += t.amount;
        acc.totalCostUsd += cost;
        acc.txCount += 1;
        if (ts && (!acc.firstTs || ts < acc.firstTs)) acc.firstTs = ts;
        if (ts > acc.lastTs) acc.lastTs = ts;
        events.push({
          kind: "buy_swap",
          mint: t.mint,
          amount: t.amount,
          usd: cost,
          ts,
          signature,
          source,
        });
      }
    }
    if (tokensOut.length > 0 && cashOutUsd > 0 && distinctMints(tokensOut) > 1) {
      unpricedSwaps += 1;
    } else if (tokensOut.length > 0 && cashOutUsd > 0) {
      const total = tokensOut.reduce((s, x) => s + x.amount, 0) || 1;
      for (const t of tokensOut) {
        const proceeds = cashOutUsd * (t.amount / total);
        let acc = sells.get(t.mint);
        if (!acc) {
          acc = {
            amountSold: 0,
            totalProceedsUsd: 0,
            txCount: 0,
            firstTs: ts,
            lastTs: ts,
          };
          sells.set(t.mint, acc);
        }
        acc.amountSold += t.amount;
        acc.totalProceedsUsd += proceeds;
        acc.txCount += 1;
        if (ts && (!acc.firstTs || ts < acc.firstTs)) acc.firstTs = ts;
        if (ts > acc.lastTs) acc.lastTs = ts;
        events.push({
          kind: "sell_swap",
          mint: t.mint,
          amount: t.amount,
          usd: proceeds,
          ts,
          signature,
          source,
        });
      }
    }
  }

  return { buys, sells, events, unpricedSwaps };
}
