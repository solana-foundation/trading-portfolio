import { NextResponse } from "next/server";
import { mapError } from "@/lib/portfolio/errors";
import {
  getAggregateTradePnL,
  getPortfolioHoldings,
} from "@/lib/portfolio/pnl";
import { parseWalletsBody } from "@/lib/portfolio/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(request: Request) {
  const parsed = await parseWalletsBody(request);
  if (!parsed.ok) {
    return NextResponse.json(
      { error: parsed.error },
      { status: parsed.status },
    );
  }
  try {
    const holdings = await getPortfolioHoldings(parsed.wallets);
    const netWorth = holdings.reduce((s, h) => s + h.totalValue, 0);
    const result = await getAggregateTradePnL(
      parsed.wallets,
      holdings,
      netWorth,
    );
    return NextResponse.json({
      netWorthUsd: netWorth,
      summary: result.summary,
      totals: result.totals,
      perWalletValue: Object.fromEntries(
        parsed.wallets.map((w, i) => [w, holdings[i]?.totalValue ?? 0]),
      ),
      solPriceUsd: result.solPriceUsd,
      walletsScanned: result.walletsScanned,
      hasUnpriced: result.hasUnpriced,
      historyTruncated: result.historyTruncated,
    });
  } catch (e) {
    const mapped = mapError(e, "Failed to compute portfolio summary.");
    return NextResponse.json(
      { error: mapped.error },
      { status: mapped.status },
    );
  }
}
