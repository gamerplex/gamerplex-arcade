#!/usr/bin/env tsx
/**
 * v1.3 upgrade migration — idempotent.
 *
 * Run on devnet AFTER `anchor upgrade --program-id 4FVwdxx...`:
 *   1. initialize_exchange_rates (one-time PDA open)
 *   2. update_accepted_stablecoins([USDC]) — devnet stays USDC-only
 *   3. register_game(5, "flipball", "Flipball") — new game slot
 *
 * Mainnet bootstrap runs the same sequence + the multi-stable allowlist:
 *   MAINNET=1 npx tsx migrations/v1_3-upgrade.ts
 *   (also includes USDT + USDF in the allowlist)
 *
 * Requires:
 *   - Funded admin wallet at KEYPAIR_PATH (devnet: ~/.config/solana/id.json;
 *     mainnet: pass a FRESH mainnet keypair via env)
 *   - target/idl/gamerplex_arcade.json (refresh first via `anchor build`)
 */
import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { readFileSync } from "fs";
import * as path from "path";

const MAINNET = !!process.env.MAINNET;
const PROGRAM_ID = new PublicKey(
  process.env.PROGRAM_ID ||
    (MAINNET
      ? (() => { throw new Error("Set PROGRAM_ID= to the FRESH mainnet program keypair pubkey"); })()
      : "4FVwdxxBp6PTax2tAcPyHE9rYt8tyNf2YBGrSnSqmx8t")
);
const RPC =
  process.env.SOLANA_RPC ||
  (MAINNET ? "https://api.mainnet-beta.solana.com" : "https://api.devnet.solana.com");

const KEYPAIR_PATH =
  process.env.KEYPAIR_PATH || (process.env.HOME || "~") + "/.config/solana/id.json";

const USDC_MAINNET = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const USDT_MAINNET = new PublicKey("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB");
const USDF_MAINNET = new PublicKey("5AMAA9JV9H97YYVxx8F6FsCMmTwXSuTTQneiup4RYAUQ");
const USDC_DEVNET = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");

const FLIPBALL_GAME_ID = 5;
const FLIPBALL_SLUG = "flipball";
const FLIPBALL_NAME = "Flipball";

const RATE_SCALE = 1_000_000_000_000n;

function pda(seeds: (Buffer | Uint8Array)[]): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(seeds, PROGRAM_ID);
}

function loadAdmin(): Keypair {
  const raw = JSON.parse(readFileSync(KEYPAIR_PATH, "utf8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

function deadlineSec(secondsFromNow = 3600): BN {
  return new BN(Math.floor(Date.now() / 1000) + secondsFromNow);
}

/**
 * Convert dollars per native unit to ratescaled (micro-USD per smallest unit × 1e12).
 * Example: SOL = $150 → 150 USD per 1e9 lamports → 0.15 micro-USD per lamport.
 * Stored as 0.15 × 1e12 = 150_000_000_000.
 */
function quoteToScaled(usdPerNative: number, nativeDecimals: number): BN {
  const microUsdPerNative = usdPerNative * 1_000_000;
  const microUsdPerSmallestUnit = microUsdPerNative / 10 ** nativeDecimals;
  const scaled = microUsdPerSmallestUnit * Number(RATE_SCALE);
  return new BN(Math.floor(scaled));
}

async function main() {
  console.log(`\n=== gamerplex-arcade v1.3 upgrade (${MAINNET ? "MAINNET" : "devnet"}) ===`);
  console.log(`  Program: ${PROGRAM_ID.toBase58()}`);
  console.log(`  RPC:     ${RPC}`);

  const admin = loadAdmin();
  console.log(`  Admin:   ${admin.publicKey.toBase58()}\n`);

  const conn = new Connection(RPC, "confirmed");
  const wallet = new anchor.Wallet(admin);
  const provider = new anchor.AnchorProvider(conn, wallet, { commitment: "confirmed" });
  anchor.setProvider(provider);

  const idlPath = path.join(__dirname, "..", "target", "idl", "gamerplex_arcade.json");
  const idl = JSON.parse(readFileSync(idlPath, "utf8"));
  const program = new Program(idl, provider) as Program<any>;

  const [configAddr] = pda([Buffer.from("config")]);
  const [stablecoinsAddr] = pda([Buffer.from("stablecoins")]);
  const [ratesAddr] = pda([Buffer.from("rates")]);

  // ── Step 1: initialize_exchange_rates (one-time) ───────────────────────
  console.log("Step 1: ExchangeRatesConfig");
  const ratesInfo = await conn.getAccountInfo(ratesAddr);
  if (!ratesInfo) {
    const solRate = quoteToScaled(150, 9);  // SOL ≈ $150 (refresh before mainnet)
    const gameRate = quoteToScaled(0.0105, 10); // $GAME ≈ $0.0105 (curve floor)
    console.log(`  → init rates: SOL=$150 scaled=${solRate.toString()}, GAME=$0.0105 scaled=${gameRate.toString()}`);
    const sig = await (program.methods as any)
      .initializeExchangeRates(solRate, gameRate)
      .accounts({
        config: configAddr,
        rates: ratesAddr,
        admin: admin.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    console.log(`  ✓ rates initialised: ${sig.slice(0, 20)}…`);
  } else {
    console.log("  → already exists, updating with current quotes…");
    const solRate = quoteToScaled(Number(process.env.SOL_USD || "150"), 9);
    const gameRate = quoteToScaled(Number(process.env.GAME_USD || "0.0105"), 10);
    const sig = await (program.methods as any)
      .updateExchangeRates(solRate, gameRate, deadlineSec())
      .accounts({
        config: configAddr,
        rates: ratesAddr,
        admin: admin.publicKey,
      })
      .rpc();
    console.log(`  ✓ rates updated: ${sig.slice(0, 20)}…`);
  }

  // ── Step 2: update_accepted_stablecoins ────────────────────────────────
  console.log("\nStep 2: StablecoinConfig allowlist");
  const wanted: PublicKey[] = MAINNET
    ? [USDC_MAINNET, USDT_MAINNET, USDF_MAINNET]
    : [USDC_DEVNET];
  const padded: PublicKey[] = [];
  for (let i = 0; i < 8; i++) padded.push(i < wanted.length ? wanted[i] : PublicKey.default);
  console.log(`  → setting allowlist: ${wanted.map(p => p.toBase58().slice(0, 8) + "…").join(", ")}`);
  const sig2 = await (program.methods as any)
    .updateAcceptedStablecoins(padded, deadlineSec())
    .accounts({
      config: configAddr,
      stablecoinConfig: stablecoinsAddr,
      admin: admin.publicKey,
    })
    .rpc();
  console.log(`  ✓ stablecoins updated: ${sig2.slice(0, 20)}…`);

  // ── Step 3: initialize_affiliate_config ────────────────────────────────
  console.log("\nStep 3: AffiliateConfig (kill-switch + min-accrual)");
  const [affiliateAddr] = pda([Buffer.from("affiliate")]);
  const affInfo = await conn.getAccountInfo(affiliateAddr);
  if (!affInfo) {
    const sigAff = await (program.methods as any)
      .initializeAffiliateConfig(new BN(150_000))
      .accounts({
        config: configAddr,
        affiliateConfig: affiliateAddr,
        admin: admin.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    console.log(`  ✓ affiliate config initialised (min=$0.15): ${sigAff.slice(0, 20)}…`);
  } else {
    console.log("  → affiliate config already exists, skipping");
  }

  // ── Step 4: register_game(5, flipball) ─────────────────────────────────
  console.log("\nStep 4: register FLIPBALL");
  const [flipballGame] = pda([Buffer.from("game"), Buffer.from([FLIPBALL_GAME_ID])]);
  const existingGame = await conn.getAccountInfo(flipballGame);
  if (!existingGame) {
    const sig3 = await (program.methods as any)
      .registerGame(FLIPBALL_GAME_ID, FLIPBALL_SLUG, FLIPBALL_NAME, deadlineSec())
      .accounts({
        config: configAddr,
        game: flipballGame,
        admin: admin.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    console.log(`  ✓ flipball registered (game_id=5): ${sig3.slice(0, 20)}…`);
  } else {
    console.log("  → flipball already registered, skipping");
  }

  // ── Summary ────────────────────────────────────────────────────────────
  const rates: any = await (program.account as any).exchangeRatesConfig.fetch(ratesAddr);
  const sc: any = await (program.account as any).stablecoinConfig.fetch(stablecoinsAddr);
  const aff: any = await (program.account as any).affiliateConfig.fetch(affiliateAddr);
  const fb: any = await (program.account as any).game.fetch(flipballGame);
  console.log("\n=== State ===");
  console.log("rates.sol_micro_usd_per_lamport :", rates.solMicroUsdPerLamport.toString());
  console.log("rates.game_micro_usd_per_quark  :", rates.gameMicroUsdPerQuark.toString());
  console.log("rates.sol_updated_at            :", new Date(Number(rates.solUpdatedAt) * 1000).toISOString());
  console.log("stablecoins                     :", sc.mints.filter((m: PublicKey) => !m.equals(PublicKey.default)).map((m: PublicKey) => m.toBase58()).join(", "));
  console.log("affiliate.disabled              :", aff.disabled);
  console.log("affiliate.min_accrual_micro     :", aff.minAccrualMicro.toString());
  console.log("flipball game_id                :", fb.gameId);
  console.log("flipball slug                   :", fb.slug);
  console.log(`\n✓ v1.3 upgrade complete on ${MAINNET ? "MAINNET" : "devnet"}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
