# ec-chime — CHIME house seat taker

Trades the CHIME floor's own seat on DreamDEX Event Contracts: each cycle it
picks the soonest-closing Trading window, reads CHIME's cached seat decision
(`GET /api/agents/window`), and takes `seats[0]`'s side via IOC through the
battle-tested `placeLimit` path (integer tick/lot math — no float-price
reverts). Claims via `maybeClaim` every loop.

## Quick start (local)

```bash
npm install
npm start -w ec-chime        # DRY_RUN=true by default
```

## Environment variables

| Variable             | Required | Default                        | Notes                              |
| -------------------- | -------- | ------------------------------ | ---------------------------------- |
| `NETWORK`            | yes      | `testnet`                      | `testnet` or `mainnet`             |
| `PRIVATE_KEY`        | yes*     | —                              | House wallet key (funded). *Not needed in DRY_RUN. |
| `VENUE_ID`           | yes      | —                              | DreamDEX venue bytes32 id          |
| `DRY_RUN`            | no       | `true`                         | Set `false` to send real orders    |
| `CHIME_API`          | no       | `https://usechime.netlify.app` | Floor API base URL                 |
| `TAKE_INTERVAL_MS`   | no       | `30000`                        | Loop period in ms                  |
| `TAKE_MAX_SHARES`    | no       | `2`                            | Max shares per IOC order           |
| `TAKE_MAX_POSITION`  | no       | `20`                           | Max net position per market        |
| `AUTO_CLAIM`         | no       | `true`                         | Set `false` to skip claim sweeps   |
| `AUTO_CLAIM_INTERVAL_MS` | no  | `600000`                       | Claim sweep throttle               |

Copy `.env.example` (repo root) to `.env` and fill in values. **Never commit `.env`.**

## Production deployment (VPS + PM2)

The repo ships with an `ecosystem.config.cjs` at the root and a deploy script:

```bash
./scripts/deploy-ec-chime.sh
```

This will:

1. Typecheck the strategy.
2. `npm install` locally.
3. Rsync the repo to `/opt/ec-chime/releases/<timestamp>` on the VPS (`snel-bot`).
4. Symlink `/opt/ec-chime/shared/.env` into the release.
5. Restart via `pm2 start ecosystem.config.cjs && pm2 save`.

### First-time VPS setup

```bash
ssh snel-bot
mkdir -p /opt/ec-chime/shared /opt/ec-chime/logs
cat > /opt/ec-chime/shared/.env <<'ENVEOF'
NETWORK=testnet
PRIVATE_KEY=<house-wallet-private-key>
VENUE_ID=0x679795a0195a1b76cdebb7c51d74e058aee92919b8c3389af86ef24535e8a28c
DRY_RUN=false
CHIME_API=https://api.chime.trustfall.xyz
TAKE_MAX_SHARES=2
TAKE_MAX_POSITION=20
TAKE_INTERVAL_MS=30000
ENVEOF
chmod 600 /opt/ec-chime/shared/.env
```

Then run `./scripts/deploy-ec-chime.sh` from the repo root.

### Operational notes

- **One process per key.** Never run two bot instances with the same
  `PRIVATE_KEY`; they will race on nonces.
- **Gas reserve.** The SDK uses a fixed 10 M gas ceiling × 60 gwei ≈ 0.6 STT
  per transaction. Keep ≥ 2 STT in the wallet for headroom.
- **Collateral.** Buys escrow tUSDC (testnet) / USDso (mainnet). Keep enough
  in the wallet for the expected order flow.
- **Claim sweeps** run automatically every 10 minutes (configurable). Redeemed
  collateral returns to the wallet automatically.
- **Logs:** `pm2 logs ec-chime` or `/opt/ec-chime/logs/ec-chime.log`.

## Behaviour

- Picks the soonest-closing **Trading** market (BTC or ETH) on the venue.
- Calls the CHIME API for the seat decision; falls back to POST if the GET
  cache misses.
- Buys YES (up) or NO (down) via IOC at `touch + 0.002`, capped at
  `TAKE_MAX_SHARES`.
- Skips markets where the house already holds a position (one position per
  window).
- Empty books produce `ImmediateOrCancelNoFill` — logged and skipped, not an
  error.
- On shutdown (SIGINT/SIGTERM) cancels any resting orders it placed.
