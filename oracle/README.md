# Arcade Oracle Bot — SOL + $GAME rate pusher

Pushes fresh exchange rates into `ExchangeRatesConfig` PDA every ~15 min.

## What it does

- Polls **Pyth** for SOL/USD spot
- Polls **Flipcash Reserve curve state** for $GAME/USD (deterministic from on-chain pool reserves — no oracle needed)
- Computes scaled ×1e12 rates matching the on-chain `RATE_SCALE_FACTOR`
- Calls `update_exchange_rates` if delta >1% OR ≥1hr since last push
- Health-check endpoint at `/healthz` for monitoring

## Architecture

```
NixOS xnode (primary)  ─┐
                        ├─→ both push every 15min
GCP Cloud Run (backup) ─┘     (idempotent — last write wins)
              │
              ↓
   ExchangeRatesConfig PDA on Solana
              ↑
              └── record_payment reads on every $GAME/SOL payment
```

Redundancy: 2 independent instances in different regions/clouds. Either can keep the system live alone.

## Cybersec posture

- **Bot keypair is NOT the admin hardware wallet.** The admin's hardware wallet signs `initialize_config` and other one-time setup, but a separate "rate-pusher" keypair has been authorized via the contract's `has_one = admin` constraint.
- **Bot keypair holds 0.1 SOL float** for tx fees only.
- **If bot keypair leaks: attacker can grief rates (push wrong values) but cannot steal funds** — contract has no escrow.
- **Mitigation:** even with leaked bot keypair, the worst case is denial-of-service (push rates to break payments) which is recoverable by admin rotating the bot keypair.

⚠️ Current `has_one = admin` constraint means the bot keypair IS the admin keypair if used. **Recommended v1.4 enhancement:** add a dedicated `rate_oracle: Pubkey` field on ArcadeConfig with a separate `has_one = rate_oracle` check on `update_exchange_rates`. For v1.3 the bot signs as admin (acceptable given Arcade Gate posture).

## Deployment

```bash
# NixOS xnode
nixos-rebuild test --flake .#xnode  # see ENGINEERING/feedback_sledgit_deploy_build_time_bugs.md

# GCP Cloud Run backup (use Sept-2026 credits per project_gcp_credits_september.md)
gcloud run deploy gamerplex-oracle --source=.
```

## Env vars

| Var | Purpose | Default |
|-----|---------|---------|
| `SOLANA_NETWORK` | `mainnet` or `devnet` | `devnet` |
| `SOLANA_RPC` | Helius / Triton endpoint | public default |
| `PROGRAM_ID` | Arcade program ID (fresh keypair pubkey on mainnet) | devnet `4FVwdxx…` |
| `KEYPAIR_PATH` | Bot signing keypair | `~/.config/solana/id.json` |
| `PYTH_SOL_PRICE_ACCOUNT` | Pyth price account for SOL/USD | mainnet default |
| `FLIPCASH_POOL_ADDRESS` | $GAME pool PDA (resolved from curve) | computed |
| `PUSH_INTERVAL_SEC` | How often to check + maybe push | `900` (15 min) |
| `DELTA_BPS_THRESHOLD` | Push if rate moved more than this | `100` (1%) |
| `MAX_STALE_BEFORE_PUSH_SEC` | Force push if last update older than this | `3600` (1hr) |
