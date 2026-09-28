import { NextResponse } from "next/server";
import { dbConfigured } from "@/lib/portfolio/db";
import { parseWalletsBody } from "@/lib/portfolio/request";
import { ProviderAuthError } from "@/lib/portfolio/tx-provider";
import { getValueHistory } from "@/lib/portfolio/value-history";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(request: Request) {
  const parsed = await parseWalletsBody(request);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: parsed.status });
  }
  if (!dbConfigured()) {
    return NextResponse.json(
      { error: "Value history store is not configured." },
      { status: 503 },
    );
  }
  try {
    const result = await getValueHistory(parsed.wallets);
    return NextResponse.json(result);
  } catch (e) {
    if (e instanceof ProviderAuthError) {
      console.error("portfolio: provider auth failed:", e.message);
      return NextResponse.json(
        { error: "Upstream data provider unavailable." },
        { status: 502 },
      );
    }
    console.error("portfolio: value-history failed:", (e as Error).message);
    return NextResponse.json(
      { error: "Failed to load value history." },
      { status: 502 },
    );
  }
}
