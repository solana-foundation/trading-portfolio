import { VendorError } from "@/lib/portfolio/errors";
import type { HeliusTx } from "@/lib/portfolio/swaps";
import { parseAmount, SOL_MINT } from "@/lib/portfolio/swaps";

function malformedAmount(tx: HeliusTx, field: string): VendorError {
  return new VendorError({
    vendor: "helius",
    kind: "shape",
    path: "/v0/addresses",
    message: `malformed ${field} in transaction ${tx.signature?.slice(0, 8) ?? "?"}…`,
  });
}

export const DAY_SECONDS = 86_400;

export function floorDay(ts: number): number {
  return Math.floor(ts / DAY_SECONDS) * DAY_SECONDS;
}

export type DayBalances = {
  day: number;
  balances: Map<string, number>;
};

type WalletMove = { mint: string; amount: number; incoming: boolean };

function walletMoves(tx: HeliusTx, wallet: string): WalletMove[] {
  const moves: WalletMove[] = [];
  for (const tt of tx.tokenTransfers || []) {
    const incoming = tt.toUserAccount === wallet;
    const outgoing = tt.fromUserAccount === wallet;
    if (!tt.mint || (!incoming && !outgoing)) continue;
    const amount = parseAmount(tt.tokenAmount);
    if (amount === null) throw malformedAmount(tx, "tokenAmount");
    if (amount <= 0) continue;
    if (incoming) moves.push({ mint: tt.mint, amount, incoming: true });
    if (outgoing) moves.push({ mint: tt.mint, amount, incoming: false });
  }
  for (const nt of tx.nativeTransfers || []) {
    const incoming = nt.toUserAccount === wallet;
    const outgoing = nt.fromUserAccount === wallet;
    if (!incoming && !outgoing) continue;
    const lamports = parseAmount(nt.amount);
    if (lamports === null) throw malformedAmount(tx, "amount");
    const sol = lamports / 1e9;
    if (sol <= 0) continue;
    if (incoming) moves.push({ mint: SOL_MINT, amount: sol, incoming: true });
    if (outgoing) moves.push({ mint: SOL_MINT, amount: sol, incoming: false });
  }
  return moves;
}

function undoTx(balances: Map<string, number>, moves: WalletMove[]): void {
  for (const move of moves) {
    const delta = move.incoming ? -move.amount : move.amount;
    balances.set(move.mint, (balances.get(move.mint) || 0) + delta);
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
  for (const t of sorted) walletMoves(t, wallet);

  const genesisDay = floorDay(sorted[sorted.length - 1].timestamp || 0);
  const balances = new Map(currentBalances);
  const out: DayBalances[] = [];
  let i = 0;

  for (
    let day = todayDay - DAY_SECONDS;
    day >= genesisDay;
    day -= DAY_SECONDS
  ) {
    while (
      i < sorted.length &&
      (sorted[i].timestamp || 0) > day + DAY_SECONDS - 1
    ) {
      undoTx(balances, walletMoves(sorted[i], wallet));
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
