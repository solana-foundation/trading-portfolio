import { describe, expect, it } from "vitest";
import {
  aggregateSwapEvents,
  SOL_MINT,
  synthesizeSwapFromTransfers,
  type HeliusTx,
} from "@/lib/portfolio/swaps";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const MEME = "MemeMintAddr1111111111111111111111111111111";
const WALLET = "Wa11etAddr111111111111111111111111111111111";
const SOL_PRICE = 200;
const solAt = () => SOL_PRICE;

function swapTx(partial: Partial<HeliusTx>): HeliusTx {
  return {
    type: "SWAP",
    timestamp: 1_700_000_000,
    signature: "sig1",
    source: "JUPITER",
    ...partial,
  };
}

describe("aggregateSwapEvents", () => {
  it("records a USDC-funded buy at its cash cost", () => {
    const tx = swapTx({
      events: {
        swap: {
          tokenInputs: [
            {
              userAccount: WALLET,
              mint: USDC,
              rawTokenAmount: { tokenAmount: "100000000", decimals: 6 },
            },
          ],
          tokenOutputs: [
            {
              userAccount: WALLET,
              mint: MEME,
              rawTokenAmount: { tokenAmount: "5000", decimals: 0 },
            },
          ],
        },
      },
    });
    const { buys, sells, events } = aggregateSwapEvents(WALLET, [tx], solAt);
    const buy = buys.get(MEME);
    expect(buy).toBeDefined();
    expect(buy?.amountBought).toBe(5000);
    expect(buy?.totalCostUsd).toBeCloseTo(100);
    expect(sells.size).toBe(0);
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("buy_swap");
  });

  it("records a SOL-funded buy priced via SOL/USD", () => {
    const tx = swapTx({
      events: {
        swap: {
          nativeInput: { account: WALLET, amount: String(2e9) },
          tokenOutputs: [
            {
              userAccount: WALLET,
              mint: MEME,
              rawTokenAmount: { tokenAmount: "1000", decimals: 0 },
            },
          ],
        },
      },
    });
    const { buys } = aggregateSwapEvents(WALLET, [tx], solAt);
    expect(buys.get(MEME)?.totalCostUsd).toBeCloseTo(400);
  });

  it("records a sell into SOL as proceeds", () => {
    const tx = swapTx({
      events: {
        swap: {
          tokenInputs: [
            {
              userAccount: WALLET,
              mint: MEME,
              rawTokenAmount: { tokenAmount: "1000", decimals: 0 },
            },
          ],
          nativeOutput: { account: WALLET, amount: String(1e9) },
        },
      },
    });
    const { sells, events } = aggregateSwapEvents(WALLET, [tx], solAt);
    expect(sells.get(MEME)?.totalProceedsUsd).toBeCloseTo(200);
    expect(events[0]?.kind).toBe("sell_swap");
  });

  it("splits multi-entry same-mint buys pro-rata by amount", () => {
    const tx = swapTx({
      events: {
        swap: {
          tokenInputs: [
            {
              userAccount: WALLET,
              mint: USDC,
              rawTokenAmount: { tokenAmount: "90000000", decimals: 6 },
            },
          ],
          tokenOutputs: [
            {
              userAccount: WALLET,
              mint: MEME,
              rawTokenAmount: { tokenAmount: "600", decimals: 0 },
            },
            {
              userAccount: WALLET,
              mint: MEME,
              rawTokenAmount: { tokenAmount: "300", decimals: 0 },
            },
          ],
        },
      },
    });
    const { buys, unpricedSwaps } = aggregateSwapEvents(WALLET, [tx], solAt);
    expect(buys.get(MEME)?.totalCostUsd).toBeCloseTo(90);
    expect(buys.get(MEME)?.amountBought).toBe(900);
    expect(unpricedSwaps).toBe(0);
  });

  it("marks multi-mint output swaps unpriced instead of misallocating", () => {
    const OTHER = "OtherMintAddr111111111111111111111111111111";
    const tx = swapTx({
      events: {
        swap: {
          tokenInputs: [
            {
              userAccount: WALLET,
              mint: USDC,
              rawTokenAmount: { tokenAmount: "90000000", decimals: 6 },
            },
          ],
          tokenOutputs: [
            {
              userAccount: WALLET,
              mint: MEME,
              rawTokenAmount: { tokenAmount: "600", decimals: 0 },
            },
            {
              userAccount: WALLET,
              mint: OTHER,
              rawTokenAmount: { tokenAmount: "300", decimals: 0 },
            },
          ],
        },
      },
    });
    const { buys, unpricedSwaps } = aggregateSwapEvents(WALLET, [tx], solAt);
    expect(buys.size).toBe(0);
    expect(unpricedSwaps).toBe(1);
  });

  it("ignores swap legs belonging to other wallets", () => {
    const tx = swapTx({
      events: {
        swap: {
          tokenInputs: [
            {
              userAccount: "SomeoneE1se11111111111111111111111111111111",
              mint: USDC,
              rawTokenAmount: { tokenAmount: "100000000", decimals: 6 },
            },
          ],
          tokenOutputs: [
            {
              userAccount: "SomeoneE1se11111111111111111111111111111111",
              mint: MEME,
              rawTokenAmount: { tokenAmount: "5000", decimals: 0 },
            },
          ],
        },
      },
    });
    const { buys, sells } = aggregateSwapEvents(WALLET, [tx], solAt);
    expect(buys.size).toBe(0);
    expect(sells.size).toBe(0);
  });
});

describe("synthesizeSwapFromTransfers", () => {
  it("builds a swap from transfers when the parsed event is missing", () => {
    const tx: HeliusTx = {
      type: "SWAP",
      timestamp: 1_700_000_000,
      tokenTransfers: [
        { toUserAccount: WALLET, mint: MEME, tokenAmount: 1000 },
      ],
      nativeTransfers: [
        { fromUserAccount: WALLET, amount: 2e9 },
      ],
    };
    const synth = synthesizeSwapFromTransfers(tx, WALLET);
    expect(synth).not.toBeNull();
    expect(synth?.tokenOutputs).toHaveLength(1);
    expect(synth?.nativeInput?.amount).toBe(String(2e9));

    const { buys } = aggregateSwapEvents(WALLET, [tx], solAt);
    expect(buys.get(MEME)?.totalCostUsd).toBeCloseTo(400);
  });

  it("treats sub-threshold native movement as fees, not cash", () => {
    const tx: HeliusTx = {
      type: "SWAP",
      tokenTransfers: [{ toUserAccount: WALLET, mint: MEME, tokenAmount: 10 }],
      nativeTransfers: [{ fromUserAccount: WALLET, amount: 500_000 }],
    };
    const synth = synthesizeSwapFromTransfers(tx, WALLET);
    expect(synth?.nativeInput).toBeNull();
  });

  it("returns null for non-swap transactions", () => {
    const tx: HeliusTx = {
      type: "TRANSFER",
      tokenTransfers: [{ toUserAccount: WALLET, mint: MEME, tokenAmount: 10 }],
    };
    expect(synthesizeSwapFromTransfers(tx, WALLET)).toBeNull();
  });

  it("never prices SOL cash legs without a SOL price", () => {
    const tx = swapTx({
      events: {
        swap: {
          nativeInput: { account: WALLET, amount: String(2e9) },
          tokenOutputs: [
            {
              userAccount: WALLET,
              mint: MEME,
              rawTokenAmount: { tokenAmount: "1000", decimals: 0 },
            },
          ],
        },
      },
    });
    const { buys } = aggregateSwapEvents(WALLET, [tx], () => 0);
    expect(buys.size).toBe(0);
  });

  it("mint constant sanity", () => {
    expect(SOL_MINT).toBe("So11111111111111111111111111111111111111112");
  });
});
