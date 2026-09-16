import { SOL_MINT } from "@/lib/portfolio/swaps";
import type { HeliusTx } from "@/lib/portfolio/swaps";

export const DAY_SECONDS = 86_400;

export function floorDay(ts: number): number {
  return Math.floor(ts / DAY_SECONDS) * DAY_SECONDS;
}

export type DayBalances = {
  day: number;
  balances: Map<string, number>;
};

function undoTx(
  balances: Map<string, number>,
  tx: HeliusTx,
  wallet: string,
): void {
  for (const tt of tx.tokenTransfers || []) {
    if (!tt.mint) continue;
    const amount = Number.parseFloat(String(tt.tokenAmount ?? 0)) || 0;
    if (amount <= 0) continue;
    if (tt.toUserAccount === wallet) {
      balances.set(tt.mint, (balances.get(tt.mint) || 0) - amount);
    }
    if (tt.fromUserAccount === wallet) {
      balances.set(tt.mint, (balances.get(tt.mint) || 0) + amount);
    }
  }
  for (const nt of tx.nativeTransfers || []) {
    const sol = (Number.parseFloat(String(nt.amount ?? 0)) || 0) / 1e9;
    if (sol <= 0) continue;
    if (nt.toUserAccount === wallet) {
      balances.set(SOL_MINT, (balances.get(SOL_MINT) || 0) - sol);
    }
    if (nt.fromUserAccount === wallet) {
      balances.set(SOL_MINT, (balances.get(SOL_MINT) || 0) + sol);
    }
  }
}

export function reconstructDailyBalances(
  wallet: string,
  currentBalances: Map<string, number>,
  txs: HeliusTx[],
  todayDay: number,
): DayBalances[] {
  const sorted = txs
    .filter((t) => (t.timestamp || 0) > 0)
    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  if (sorted.length === 0) return [];

  const genesisDay = floorDay(sorted[sorted.length - 1].timestamp || 0);
  const balances = new Map(currentBalances);
  const out: DayBalances[] = [];
  let i = 0;

  for (let day = todayDay - DAY_SECONDS; day >= genesisDay; day -= DAY_SECONDS) {
    while (i < sorted.length && (sorted[i].timestamp || 0) > day + DAY_SECONDS - 1) {
      undoTx(balances, sorted[i], wallet);
      i++;
    }
    const snapshot = new Map<string, number>();
    for (const [mint, amount] of balances) {
      if (amount > 0) snapshot.set(mint, amount);
    }
    out.push({ day, balances: snapshot });
  }

  out.reverse();
  return out;
}
