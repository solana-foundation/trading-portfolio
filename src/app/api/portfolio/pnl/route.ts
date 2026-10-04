import { NextResponse } from "next/server";
import { requestBudget } from "@/lib/portfolio/deadline";
import { mapError } from "@/lib/portfolio/errors";
import {
  getAggregateTradePnL,
  getPortfolioHoldings,
} from "@/lib/portfolio/pnl";
import { parseWalletsBody } from "@/lib/portfolio/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const REQUEST_BUDGET_MS = 110_000;

export const maxDuration = 120;

export async function POST(request: Request) {
  const parsed = await parseWalletsBody(request);
  if (!parsed.ok) {
    return NextResponse.json(
      { error: parsed.error },
      { status: parsed.status },
    );
  }
  const within = requestBudget(REQUEST_BUDGET_MS, "pnl");
  try {
    const holdings = await within(getPortfolioHoldings(parsed.wallets));
    const netWorth = holdings.reduce((s, h) => s + h.totalValue, 0);
    const result = await within(
      getAggregateTradePnL(parsed.wallets, holdings, netWorth),
    );
    return NextResponse.json(result);
  } catch (e) {
    const mapped = mapError(e, "Failed to compute portfolio PnL.");
    return NextResponse.json(
      { error: mapped.error },
      { status: mapped.status },
    );
  }
}
