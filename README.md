# gamerplex-arcade

Anchor program for solo-arcade skill-score settlement on Solana. Powers gamerplex.com Arcade Mode.

## Status

| | |
|---|---|
| Devnet program ID | `4FVwdxxBp6PTax2tAcPyHE9rYt8tyNf2YBGrSnSqmx8t` |
| Status | Live devnet — mainnet pending |
| Anchor version | 0.32.1 |
| License | MIT |

## What it does

Three-tier permanence model. Player plays a game (off-chain), then optionally saves their score on-chain at one of four price points. Higher tiers buy stronger replay-ability + cNFT receipt.

| Tier | Price (USDF) | What it stores |
|---|---|---|
| T1 | $0.05 | GPX5 memo (signature-indexed score, no PDA) |
| T2 | $0.15 | GPX5R replay receipt PDA with input log |
| T3 | $0.25 | cNFT receipt PDA, tradeable proof |
| T4 | (deferred to v1.3) | Bubblegum cNFT compressed mint |

Fees: fixed per-tier service fees ($0.05 / $0.15 / $0.25 shown above), routed via `record_payment` to treasury accounts. Affiliate cut configurable via `AFFILIATE_CUT_BPS` (default 20% of the service fee).

## Build

```bash
git clone https://github.com/gamerplex/gamerplex-arcade
cd gamerplex-arcade
anchor build
```

## Deploy

```bash
solana program deploy target/deploy/gamerplex_arcade.so \
  --program-id programs/gamerplex-arcade/target-keypair.json \
  --url devnet
```

Re-derive program-keypair locally — never commit it. `target-keypair.json` is gitignored.

## Test

```bash
anchor test --skip-deploy --skip-build
```

## Integration

Frontend uses `lib/arcade/client.ts` in gamerplex-com to call into this program. See [gamerplex/gamerplex-com](https://github.com/gamerplex/gamerplex-com) for the client-side path.

## Sister repos

- [gamerplex/gamerplex-com](https://github.com/gamerplex/gamerplex-com) — frontend
- [contention-markets/cm-contract](https://github.com/contention-markets/cm-contract) — CM v2.1 settlement for Battle mode
- [gamerplex/gamerplex-dev](https://github.com/gamerplex/gamerplex-dev) — sovereign dev harness + SKILL.md

## Security

Open a support ticket in our Discord (linked from gamerplex.com).

## License

MIT
