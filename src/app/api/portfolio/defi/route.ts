import { NextResponse } from "next/server";
import { getDefiPositions } from "@/lib/portfolio/defi";
import { mapError } from "@/lib/portfolio/errors";
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
    const result = await getDefiPositions(parsed.wallets);
    return NextResponse.json(result);
  } catch (e) {
    const mapped = mapError(e, "Failed to load DeFi positions.");
    return NextResponse.json(
      { error: mapped.error },
      { status: mapped.status },
    );
  }
}
