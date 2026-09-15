import { NextResponse } from "next/server";
import { ProviderAuthError } from "@/lib/portfolio/tx-provider";
import { getAggregateTradePnL, getPortfolioHoldings } from "@/lib/portfolio/pnl";
import { parseWalletsBody } from "@/lib/portfolio/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(request: Request) {
  const parsed = await parseWalletsBody(request);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }
  try {
    const holdings = await getPortfolioHoldings(parsed.wallets);
    const netWorth = holdings.reduce((s, h) => s + h.totalValue, 0);
    const result = await getAggregateTradePnL(parsed.wallets, holdings, netWorth);
    return NextResponse.json(result);
  } catch (e) {
    if (e instanceof ProviderAuthError) {
      console.error("portfolio: provider auth failed:", e.message);
      return NextResponse.json(
        { error: "Upstream data provider unavailable." },
        { status: 502 },
      );
    }
    console.error("portfolio: pnl failed:", (e as Error).message);
    return NextResponse.json(
      { error: "Failed to compute portfolio PnL." },
      { status: 502 },
    );
  }
}
