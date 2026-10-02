import { NextResponse } from "next/server";
import { dbConfigured } from "@/lib/portfolio/db";
import { requestBudget } from "@/lib/portfolio/deadline";
import { mapError } from "@/lib/portfolio/errors";
import { parseWalletsBody } from "@/lib/portfolio/request";
import { getValueHistory } from "@/lib/portfolio/value-history";

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
  if (!dbConfigured()) {
    return NextResponse.json(
      { error: "Value history store is not configured." },
      { status: 503 },
    );
  }
  try {
    const within = requestBudget(REQUEST_BUDGET_MS, "value-history");
    const result = await within(getValueHistory(parsed.wallets));
    return NextResponse.json(result);
  } catch (e) {
    const mapped = mapError(e, "Failed to load value history.");
    return NextResponse.json(
      { error: mapped.error },
      { status: mapped.status },
    );
  }
}
