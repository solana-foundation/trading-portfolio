export type Cashflow = { ts: number; amount: number };

export function computeXIRR(cashflows: Cashflow[]): number | null {
  if (!cashflows || cashflows.length < 2) return null;
  const cf = [...cashflows].filter(
    (c) => Number.isFinite(c.amount) && Number.isFinite(c.ts),
  );
  cf.sort((a, b) => a.ts - b.ts);
  if (cf.length < 2) return null;

  let hasPos = false;
  let hasNeg = false;
  for (const c of cf) {
    if (c.amount > 0) hasPos = true;
    else if (c.amount < 0) hasNeg = true;
  }
  if (!hasPos || !hasNeg) return null;

  const first = cf[0];
  if (!first) return null;
  const t0 = first.ts;
  const years = (c: Cashflow) => (c.ts - t0) / (365.25 * 86400);
  const npv = (r: number) =>
    cf.reduce((s, c) => s + c.amount / (1 + r) ** years(c), 0);
  const dnpv = (r: number) =>
    cf.reduce((s, c) => {
      const y = years(c);
      return s + (c.amount * -y) / (1 + r) ** (y + 1);
    }, 0);

  let r = 0.1;
  for (let i = 0; i < 200; i++) {
    const f = npv(r);
    if (Math.abs(f) < 1e-6) return r;
    const df = dnpv(r);
    if (!Number.isFinite(df) || Math.abs(df) < 1e-12) break;
    let next = r - f / df;
    if (!Number.isFinite(next)) break;
    if (next <= -0.999) next = -0.99;
    if (Math.abs(next - r) < 1e-9) return next;
    r = next;
  }

  let lo = -0.99;
  let hi = 100;
  let fLo = npv(lo);
  const fHi = npv(hi);
  if (!Number.isFinite(fLo) || !Number.isFinite(fHi) || fLo * fHi > 0) {
    return null;
  }
  for (let i = 0; i < 400; i++) {
    const mid = (lo + hi) / 2;
    const f = npv(mid);
    if (!Number.isFinite(f)) return null;
    if (Math.abs(f) < 1e-6) return mid;
    if (f * fLo < 0) hi = mid;
    else {
      lo = mid;
      fLo = f;
    }
  }
  return (lo + hi) / 2;
}
