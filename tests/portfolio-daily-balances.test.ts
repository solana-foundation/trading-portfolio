import { describe, expect, it } from "vitest";
import {
  DAY_SECONDS,
  reconstructDailyBalances,
} from "@/lib/portfolio/daily-balances";
import { VendorError } from "@/lib/portfolio/errors";
import type { HeliusTx } from "@/lib/portfolio/swaps";
import { SOL_MINT } from "@/lib/portfolio/swaps";

const W = "walletA";
const OTHER = "walletB";
const MINT = "MintXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";

const TODAY = 20_000 * DAY_SECONDS;

function tx(partial: Partial<HeliusTx>): HeliusTx {
  return { signature: "sig", timestamp: 0, ...partial } as HeliusTx;
}

describe("reconstructDailyBalances", () => {
  it("returns empty for no timestamped txs", () => {
    expect(reconstructDailyBalances(W, new Map(), [], TODAY)).toEqual([]);
  });

  it("walks balances backward through inbound and outbound transfers", () => {
    const txs: HeliusTx[] = [
      tx({
        timestamp: TODAY - 3 * DAY_SECONDS + 100,
        tokenTransfers: [
          {
            mint: MINT,
            tokenAmount: 10,
            fromUserAccount: OTHER,
            toUserAccount: W,
          },
        ],
      }),
      tx({
        timestamp: TODAY - 1 * DAY_SECONDS + 100,
        tokenTransfers: [
          {
            mint: MINT,
            tokenAmount: 4,
            fromUserAccount: W,
            toUserAccount: OTHER,
          },
        ],
      }),
    ];
    const days = reconstructDailyBalances(W, new Map([[MINT, 6]]), txs, TODAY);

    expect(days).toHaveLength(3);
    expect(days[0].day).toBe(TODAY - 3 * DAY_SECONDS);
    expect(days[0].balances.get(MINT)).toBe(10);
    expect(days[1].balances.get(MINT)).toBe(10);
    expect(days[2].balances.get(MINT)).toBe(6);
  });

  it("converts native transfers to SOL and drops non-positive balances", () => {
    const txs: HeliusTx[] = [
      tx({
        timestamp: TODAY - 3 * DAY_SECONDS + 5,
        tokenTransfers: [
          {
            mint: MINT,
            tokenAmount: 1,
            fromUserAccount: OTHER,
            toUserAccount: OTHER,
          },
        ],
      }),
      tx({
        timestamp: TODAY - 1 * DAY_SECONDS + 5,
        nativeTransfers: [
          { amount: 2_000_000_000, fromUserAccount: OTHER, toUserAccount: W },
        ],
      }),
    ];
    const days = reconstructDailyBalances(
      W,
      new Map([[SOL_MINT, 2]]),
      txs,
      TODAY,
    );

    expect(days).toHaveLength(3);
    expect(days[0].balances.has(SOL_MINT)).toBe(false);
    expect(days[1].balances.has(SOL_MINT)).toBe(false);
    expect(days[2].balances.get(SOL_MINT)).toBe(2);
  });

  it("ignores transfers between other wallets", () => {
    const txs: HeliusTx[] = [
      tx({
        timestamp: TODAY - 1 * DAY_SECONDS + 5,
        tokenTransfers: [
          {
            mint: MINT,
            tokenAmount: 5,
            fromUserAccount: OTHER,
            toUserAccount: OTHER,
          },
        ],
      }),
    ];
    const days = reconstructDailyBalances(W, new Map([[MINT, 3]]), txs, TODAY);
    expect(days[0].balances.get(MINT)).toBe(3);
  });
});

describe("malformed amounts", () => {
  it("fails closed instead of reconstructing balances from a malformed amount", () => {
    const txs: HeliusTx[] = [
      tx({
        signature: "bad",
        timestamp: TODAY - 3 * DAY_SECONDS + 100,
        tokenTransfers: [
          { toUserAccount: W, mint: MINT, tokenAmount: "10garbage" },
        ],
      }),
      tx({
        signature: "older",
        timestamp: TODAY - 5 * DAY_SECONDS + 100,
        tokenTransfers: [{ toUserAccount: W, mint: MINT, tokenAmount: "1" }],
      }),
    ];
    expect(() =>
      reconstructDailyBalances(W, new Map([[MINT, 6]]), txs, TODAY),
    ).toThrow(VendorError);
  });
});

describe("malformed amounts, edge cases", () => {
  it("ignores a malformed transfer that does not involve the wallet", () => {
    const txs: HeliusTx[] = [
      tx({
        signature: "other",
        timestamp: TODAY - 3 * DAY_SECONDS + 100,
        tokenTransfers: [
          {
            fromUserAccount: OTHER,
            toUserAccount: "walletC",
            mint: MINT,
            tokenAmount: "10garbage",
          },
          { toUserAccount: W, mint: MINT, tokenAmount: "2" },
        ],
      }),
      tx({
        signature: "older",
        timestamp: TODAY - 5 * DAY_SECONDS + 100,
        tokenTransfers: [{ toUserAccount: W, mint: MINT, tokenAmount: "1" }],
      }),
    ];
    const days = reconstructDailyBalances(W, new Map([[MINT, 6]]), txs, TODAY);
    expect(days.length).toBe(5);
    expect(days[days.length - 1].balances.get(MINT)).toBe(6);
    expect(days[0].balances.get(MINT)).toBe(4);
  });

  it("fails closed for a malformed amount on the genesis day too", () => {
    const txs: HeliusTx[] = [
      tx({
        signature: "genesis",
        timestamp: TODAY - 3 * DAY_SECONDS + 100,
        tokenTransfers: [
          { toUserAccount: W, mint: MINT, tokenAmount: "1.25oops" },
        ],
      }),
    ];
    expect(() =>
      reconstructDailyBalances(W, new Map([[MINT, 6]]), txs, TODAY),
    ).toThrow(VendorError);
  });
});
