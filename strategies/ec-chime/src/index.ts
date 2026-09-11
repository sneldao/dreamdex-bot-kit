/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

// ec-chime — the CHIME floor's house seat, traded for real.
//
// Each cycle: soonest-closing Trading window → CHIME's cached seat decision
// (GET /api/agents/window, POST to generate if missing) → take seats[0]'s
// side via IOC through placeLimit (integer tick/lot math) → maybeClaim.
//
// DRY_RUN=true (the default) logs intended takes without sending them. Set
// DRY_RUN=false + a funded PRIVATE_KEY (the house key, which DIFFERS from
// any quoter — self-matching is blocked) to trade for real.
//
//   npm start -w ec-chime

import {
  createExchange,
  envNum,
  cancelTracked,
  cancelVenueOrders,
  maybeClaim,
  loadConfig,
  shutdown,
  activeMarkets,
  explainEmptyScope,
  marketOnchain,
  isTradable,
  minLeftSec,
  netPosition,
  outcomeSymbols,
  quantize,
  assertProbability,
  clampProbability,
  placeLimit,
  type EcContext,
  type UnifiedMarket,
} from "@dreamdex-bot-kit/ec-core";
import { isBinaryMarket } from "@somnia-chain/markets-sdk";

const INTERVAL_MS = envNum("TAKE_INTERVAL_MS", 30_000);
const MAX_POSITION = envNum("TAKE_MAX_POSITION", 20);
const MAX_SHARES = envNum("TAKE_MAX_SHARES", 2);
const CHIME_API = (process.env.CHIME_API ?? "https://usechime.netlify.app").replace(/\/$/, "");
// Interruptible sleep — wakes within ~500ms of the stop flag (see maker-bot).
const sleep = async (ms: number, stopped?: () => boolean) => {
  for (let t = 0; t < ms; t += 500) {
    if (stopped?.()) return;
    await new Promise((r) => setTimeout(r, Math.min(500, ms - t)));
  }
};
const log = (s: string) => console.log(`${new Date().toISOString()} ${s}`);

interface SeatDecision {
  marketId: string;
  seats?: { label?: string; side?: "up" | "down" }[];
}

async function chimeSeat(ctx: EcContext, market: UnifiedMarket): Promise<{ side: "up" | "down"; label: string } | null> {
  const info = isBinaryMarket(market.info) ? market.info : null;
  const marketId = String(info?.marketId ?? "");
  if (!marketId) return null;
  let decision: SeatDecision | null = null;
  try {
    const res = await fetch(`${CHIME_API}/api/agents/window?marketId=${encodeURIComponent(marketId)}`);
    if (res.ok) decision = (await res.json()) as SeatDecision;
  } catch {
    decision = null;
  }
  if (!decision?.seats?.[0]?.side) {
    try {
      const onchain = await marketOnchain(ctx, market);
      const asset = market.symbol.split("-")[0] ?? "BTC";
      const res = await fetch(`${CHIME_API}/api/agents/window`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          marketId,
          asset,
          intervalSec: Number(info?.intervalSec ?? 900),
          expiry: Number(onchain?.expiry ?? 0),
          secondsLeft: Math.max(0, Number(onchain?.expiry ?? 0) - Date.now() / 1000),
          bestBid: null,
          bestAsk: null,
        }),
      });
      if (res.ok) decision = (await res.json()) as SeatDecision;
    } catch {
      return null;
    }
  }
  const seat = decision?.seats?.[0];
  if (seat?.side !== "up" && seat?.side !== "down") return null;
  return { side: seat.side, label: seat.label ?? "seat-01" };
}

async function takeOne(ctx: EcContext, market: UnifiedMarket): Promise<void> {
  // 1) Authoritative status. Resolve by marketId; act only on this snapshot.
  const onchain = await marketOnchain(ctx, market);
  if (!onchain) return;
  if (!isTradable(onchain)) return;

  const interval = isBinaryMarket(market.info) ? Number(market.info.intervalSec ?? 0) : 0;
  if (Number(onchain.expiry) - Date.now() / 1000 < minLeftSec(interval || null)) return;

  // One position per window: the house holds its take, never doubles down.
  const net = await netPosition(ctx, onchain);
  if (Math.abs(net) > 0) return;
  if (Math.abs(net) >= MAX_POSITION) return;

  // 2) CHIME seat: seats[0] side is the house side. Up = buy YES, Down = buy NO.
  const seat = await chimeSeat(ctx, market);
  if (!seat) return;

  const { yes } = outcomeSymbols(market);
  const ob = await ctx.exchange.fetchOrderBook(yes, 3);
  const top = seat.side === "up" ? ob.asks[0] : ob.bids[0];
  if (!top) {
    log(`no ${seat.side === "up" ? "ask" : "bid"} to cross on ${market.symbol} — skip`);
    return;
  }
  const [bestPrice, bestAmount] = top;
  const shares = quantize(ctx, Math.min(bestAmount, MAX_SHARES));
  if (shares <= 0) return;

  const price = clampProbability(seat.side === "up" ? bestPrice + 0.002 : bestPrice - 0.002);
  assertProbability(price);

  if (ctx.config.dryRun) {
    log(`DRY ${seat.side} ${shares} ${market.symbol} (${seat.label}) @ ~${price.toFixed(3)}`);
    return;
  }
  const res = await placeLimit(ctx, {
    market, onchain,
    outcome: seat.side === "up" ? "YES" : "NO",
    side: "buy",
    // IOC, not limit: the house crosses the touch, and a `limit` leaves the
    // unfilled remainder resting with escrow locked. Sharp edge 4 says the
    // choice must be deliberate, and for a taker the deliberate choice is
    // to take.
    price, size: shares, type: "ioc",
  });
  const txInfo = res.hash ? ` tx=${res.hash}` : "";
  log(`${seat.side} ${res.filled}/${shares} ${market.symbol} (${seat.label}) @ ~${price.toFixed(3)}${txInfo}`);
}

// Explaining an empty venue every cycle would drown the log; once a minute is
// enough to be noticed and not enough to be noise.
const EMPTY_HINT_MS = 60_000;
let lastEmptyAt = 0;


async function main() {
  // A signer is only needed to actually send orders. In DRY_RUN you can watch
  // the bot reason about live books with no key at all.
  const ctx = createExchange({ withSigner: !loadConfig().dryRun });
  log(`ec-chime up as ${ctx.exchange.walletAddress ?? "(no key, dry run)"} · dryRun=${ctx.config.dryRun} · interval=${INTERVAL_MS}ms`);

  let stop = false;
  process.on("SIGINT", () => (stop = true));
  process.on("SIGTERM", () => (stop = true));

  while (!stop) {
    try {
      // Collect anything that settled since the last pass. Self-throttled
      // (AUTO_CLAIM_INTERVAL_MS) and a no-op under AUTO_CLAIM=false.
      await maybeClaim(ctx);
      const markets = (await activeMarkets(ctx))
        .filter((m) => m.symbol.includes("BTC") || m.symbol.includes("ETH"))
        .sort((a, b) => {
          const exA = isBinaryMarket(a.info) ? Number(a.info.expiry ?? 0) : 0;
          const exB = isBinaryMarket(b.info) ? Number(b.info.expiry ?? 0) : 0;
          return exA - exB;
        });
      if (markets.length === 0) {
        const now = Date.now();
        if (now - lastEmptyAt >= EMPTY_HINT_MS) {
          lastEmptyAt = now;
          log(`no market to trade — ${await explainEmptyScope(ctx)}`);
        }
      }
      for (const m of markets.slice(0, 3)) {
        if (stop) break;
        try {
          await takeOne(ctx, m);
        } catch (e) {
          const rpc = await import("@somnia-chain/markets-sdk/native")
            .then((m) => (typeof m.getSomniaRpcError === "function" ? m.getSomniaRpcError(e) : null))
            .catch(() => null);
          const detail = rpc ? ` [node: ${rpc.message ?? rpc.code} data=${rpc.data ?? "?"}]` : "";
          log(`${m.symbol} error: ${(e as Error).message}${detail}`);
        }
      }
    } catch (e) {
      log(`cycle error: ${(e as Error).message}`);
    }
    if (stop) break;
    await sleep(INTERVAL_MS, () => stop);
  }

  // An unfilled cross rests on the book, so clean up before leaving.
  //
  // Cancel what WE placed, from our own record. Asking the indexer instead
  // reports zero: it is seconds behind, and the orders that need cancelling are
  // exactly the ones sent seconds ago. Measured — a run that left 3 orders
  // behind logged "canceled 0".
  if (!ctx.config.dryRun) {
    // Two steps, because tracking alone is not enough. An order can rest
    // on-chain while the SDK call that placed it throws on the way back — seen
    // on mainnet as "Missing or invalid parameters", after which there is no id
    // to remember. The record covers the common case immediately; the sweep
    // catches whatever the record could not know about.
    const { cancelled, tracked } = await cancelTracked(ctx);
    let swept = 0;
    try {
      swept = await cancelVenueOrders(ctx);
    } catch (e) {
      log(`shutdown sweep failed: ${(e as Error).message}`);
    }
    log(`canceled ${cancelled} of ${tracked} tracked + ${swept} swept on shutdown`);
  }

  await shutdown(ctx);
  log("ec-chime stopped");
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
