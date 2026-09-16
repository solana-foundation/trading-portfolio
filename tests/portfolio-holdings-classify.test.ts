import { describe, expect, it } from "vitest";
import { classifyHolding } from "@/lib/portfolio/birdeye";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

describe("classifyHolding", () => {
  it("keeps a priced token above dust visible", () => {
    expect(
      classifyHolding({ address: "So11111111111111111111111111111111111111112", symbol: "SOL", balance: 1, price: 200, value: 200 }),
    ).toBeUndefined();
  });

  it("flags canonical-symbol impostors", () => {
    expect(
      classifyHolding({ address: "FakeMint1111111111111111111111111111111111", symbol: "USDC", balance: 1000, price: 1, value: 1000 }),
    ).toBe("impostor");
  });

  it("keeps the real canonical mint visible", () => {
    expect(
      classifyHolding({ address: USDC, symbol: "USDC", balance: 1000, price: 1, value: 1000 }),
    ).toBeUndefined();
  });

  it("flags held tokens the vendor cannot price", () => {
    expect(
      classifyHolding({ address: "Mint1111111111111111111111111111111111111111", symbol: "X", balance: 5, price: 0, value: 0 }),
    ).toBe("unpriced");
  });

  it("flags dust", () => {
    expect(
      classifyHolding({ address: "Mint1111111111111111111111111111111111111111", symbol: "X", balance: 0.001, price: 1, value: 0.001 }),
    ).toBe("dust");
  });
});
