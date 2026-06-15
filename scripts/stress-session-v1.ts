#!/usr/bin/env tsx
/**
 * P0-3 Session PDA stress test — direct contract calls (no resolver in loop).
 *
 * Six cases, each must produce the expected pass/fail outcome:
 *   T1 — open_session → submit_score with MATCHING seed + daily variant → PASS
 *   T2 — open_session → submit_score with DIFFERENT seed → SessionSeedMismatch
 *   T3 — submit_score with daily variant + NO session passed → SessionRequired
 *   T4 — open_session → wait past expiry → submit_score → SessionExpired
 *        (SKIP_T4=1 to skip the 65s sleep)
 *   T5 — open_session for OTHER player → submit_score → SessionOwnerMismatch
 *   T6 — submit_score with RANDOM variant + no session → PASS (backwards-compat)
 *
 * Usage:
 *   cd gamerplex-arcade/scripts
 *   npx tsx stress-session-v1.ts            # all 6 (~80s with T4)
 *   SKIP_T4=1 npx tsx stress-session-v1.ts  # skip the 65s sleep
 */
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
  SYSVAR_INSTRUCTIONS_PUBKEY,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { AnchorProvider, BN, Program, Wallet, type Idl } from "@coral-xyz/anchor";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

const NETWORK = (process.env.SOLANA_NETWORK as "mainnet" | "devnet") || "devnet";
const RPC = process.env.SOLANA_RPC ||
  (NETWORK === "mainnet" ? "https://api.mainnet-beta.solana.com" : "https://api.devnet.solana.com");
const KEYPAIR_PATH = process.env.SOLANA_KEYPAIR ||
  path.join(process.env.HOME || "", ".config/solana/id.json");
const SKIP_T4 = !!process.env.SKIP_T4;

const PROGRAM_ID = new PublicKey("4FVwdxxBp6PTax2tAcPyHE9rYt8tyNf2YBGrSnSqmx8t");
const USDC_DEVNET = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const USDC_MAINNET = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const USDC_MINT = NETWORK === "mainnet" ? USDC_MAINNET : USDC_DEVNET;
const SPL_MEMO_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const STABLE_DECIMALS = 6;
const SCORE_COMMIT_MICRO_USD = 50_000;
const CATEGORY_SCORE_COMMIT = 2;
const FLIPBALL_GAME_ID = 5;

const CONFIG_SEED = Buffer.from("config");
const GAME_SEED = Buffer.from("game");
const PROFILE_SEED = Buffer.from("profile");
const STABLECOINS_SEED = Buffer.from("stablecoins");
const RATES_SEED = Buffer.from("rates");
const AFFILIATE_SEED = Buffer.from("affiliate");
const SESSION_SEED = Buffer.from("session");

const configPda = () =>
  PublicKey.findProgramAddressSync([CONFIG_SEED], PROGRAM_ID)[0];
const gamePda = (id: number) =>
  PublicKey.findProgramAddressSync([GAME_SEED, Buffer.from([id])], PROGRAM_ID)[0];
const profilePda = (p: PublicKey) =>
  PublicKey.findProgramAddressSync([PROFILE_SEED, p.toBuffer()], PROGRAM_ID)[0];
const stablecoinConfigPda = () =>
  PublicKey.findProgramAddressSync([STABLECOINS_SEED], PROGRAM_ID)[0];
const ratesPda = () =>
  PublicKey.findProgramAddressSync([RATES_SEED], PROGRAM_ID)[0];
const affiliateConfigPda = () =>
  PublicKey.findProgramAddressSync([AFFILIATE_SEED], PROGRAM_ID)[0];

function sessionPda(player: PublicKey, nonce: bigint): PublicKey {
  const nonceBuf = Buffer.alloc(8);
  nonceBuf.writeBigUInt64LE(nonce);
  return PublicKey.findProgramAddressSync(
    [SESSION_SEED, player.toBuffer(), nonceBuf],
    PROGRAM_ID,
  )[0];
}

function randomSeed(): Uint8Array {
  return crypto.randomBytes(32);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Result = { ok: boolean; sig?: string; err?: string; ms?: number };

function printRow(label: string, r: Result) {
  const icon = r.ok ? "✅" : "❌";
  const ms = r.ms ? `${r.ms}ms`.padStart(8) : "";
  const detail = r.sig ? r.sig.slice(0, 20) + "…" : (r.err ?? "").slice(0, 80);
  console.log(`  ${icon} ${label.padEnd(40)} ${ms}   ${detail}`);
}

async function buildOpenSessionIx(
  program: Program,
  player: PublicKey,
  funder: PublicKey,
  nonce: bigint,
  gameId: number,
  seed: Uint8Array,
  lifetimeSec: number,
) {
  return (program.methods as any)
    .openSession(new BN(nonce.toString()), gameId, Array.from(seed), lifetimeSec)
    .accountsPartial({
      session: sessionPda(player, nonce),
      player,
      funder,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
}

async function buildRecordPaymentIx(
  program: Program,
  player: PublicKey,
  gameId: number,
) {
  return (program.methods as any)
    .recordPayment(
      CATEGORY_SCORE_COMMIT,
      new BN(SCORE_COMMIT_MICRO_USD),
      USDC_MINT,
      new BN(SCORE_COMMIT_MICRO_USD),
      Array.from(new Uint8Array(64)),
      "",
    )
    .accountsPartial({
      config: configPda(),
      stablecoinConfig: stablecoinConfigPda(),
      game: gamePda(gameId),
      profile: profilePda(player),
      wallet: player,
      referrerProfile: null,
      rates: ratesPda(),
      affiliateConfig: affiliateConfigPda(),
      player,
      instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
    })
    .instruction();
}

async function buildSubmitScoreIx(
  program: Program,
  player: PublicKey,
  gameId: number,
  variant: string,
  seed: Uint8Array,
  sessionAccount: PublicKey | null,
) {
  return (program.methods as any)
    .submitScore(
      variant,
      new BN(1234),
      0,
      0,
      Array.from(seed),
      30,
      Array.from(crypto.createHash("sha256").update(new Uint8Array(0)).digest()),
      "",
      PublicKey.default,
    )
    .accountsPartial({
      config: configPda(),
      game: gamePda(gameId),
      profile: profilePda(player),
      wallet: player,
      player,
      memoProgram: SPL_MEMO_ID,
      instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      session: sessionAccount,
    })
    .instruction();
}

function buildUsdcTransferIx(player: PublicKey, treasury: PublicKey) {
  const fromAta = getAssociatedTokenAddressSync(USDC_MINT, player);
  const toAta = getAssociatedTokenAddressSync(USDC_MINT, treasury);
  return [
    createAssociatedTokenAccountIdempotentInstruction(player, toAta, treasury, USDC_MINT),
    createTransferCheckedInstruction(
      fromAta, USDC_MINT, toAta, player,
      BigInt(SCORE_COMMIT_MICRO_USD), STABLE_DECIMALS, [], TOKEN_PROGRAM_ID,
    ),
  ];
}

async function main() {
  console.log(`\n=== P0-3 Session PDA Stress (${NETWORK}) ===`);
  console.log(`  Program: ${PROGRAM_ID.toBase58()}`);
  console.log(`  RPC:     ${RPC}\n`);

  const kp = Keypair.fromSecretKey(
    new Uint8Array(JSON.parse(fs.readFileSync(KEYPAIR_PATH, "utf-8"))),
  );
  console.log(`Wallet: ${kp.publicKey.toBase58()}`);

  const connection = new Connection(RPC, "confirmed");
  const provider = new AnchorProvider(connection, new Wallet(kp), { commitment: "confirmed" });
  const idl = JSON.parse(fs.readFileSync(
    path.join(__dirname, "..", "target", "idl", "gamerplex_arcade.json"),
    "utf-8",
  )) as Idl;
  const program = new Program(idl, provider);

  const cfg: any = await (program.account as any).arcadeConfig.fetch(configPda());
  const treasury = cfg.treasuryWallet as PublicKey;
  console.log(`Treasury: ${treasury.toBase58()}\n`);

  const results: Result[] = [];

  // ── T1: happy path — open_session → submit_score with matching seed ──
  console.log("── T1: open_session → submit_score with matching seed + daily variant ──");
  {
    const t0 = Date.now();
    try {
      const nonce = BigInt(Date.now());
      const seed = randomSeed();
      const tx = new Transaction();
      tx.add(await buildOpenSessionIx(program, kp.publicKey, kp.publicKey, nonce, FLIPBALL_GAME_ID, seed, 3600));
      tx.add(...buildUsdcTransferIx(kp.publicKey, treasury));
      tx.add(await buildRecordPaymentIx(program, kp.publicKey, FLIPBALL_GAME_ID));
      tx.add(await buildSubmitScoreIx(
        program, kp.publicKey, FLIPBALL_GAME_ID,
        "daily|2026-06-15", seed,
        sessionPda(kp.publicKey, nonce),
      ));
      const sig = await sendAndConfirmTransaction(connection, tx, [kp]);
      results.push({ ok: true, sig, ms: Date.now() - t0 });
    } catch (e: any) {
      results.push({ ok: false, err: (e?.message || String(e)).slice(0, 200) });
    }
    printRow("T1 happy daily", results[results.length - 1]);
  }
  await sleep(800);

  // ── T2: submit with DIFFERENT seed → SessionSeedMismatch ──
  console.log("\n── T2: submit with DIFFERENT seed than committed → SessionSeedMismatch ──");
  {
    const t0 = Date.now();
    try {
      const nonce = BigInt(Date.now());
      const committedSeed = randomSeed();
      const wrongSeed = randomSeed();
      const txOpen = new Transaction();
      txOpen.add(await buildOpenSessionIx(program, kp.publicKey, kp.publicKey, nonce, FLIPBALL_GAME_ID, committedSeed, 3600));
      await sendAndConfirmTransaction(connection, txOpen, [kp]);

      const tx = new Transaction();
      tx.add(...buildUsdcTransferIx(kp.publicKey, treasury));
      tx.add(await buildRecordPaymentIx(program, kp.publicKey, FLIPBALL_GAME_ID));
      tx.add(await buildSubmitScoreIx(
        program, kp.publicKey, FLIPBALL_GAME_ID,
        "daily|2026-06-15", wrongSeed,                                   // ← mismatch
        sessionPda(kp.publicKey, nonce),
      ));
      await sendAndConfirmTransaction(connection, tx, [kp]);
      results.push({ ok: false, err: "EXPECTED FAILURE but tx succeeded" });
    } catch (e: any) {
      const msg = (e?.message || "").toLowerCase();
      const ok = msg.includes("sessionseedmismatch") || msg.includes("seedmismatch");
      results.push({ ok, err: ok ? "SessionSeedMismatch (expected)" : "wrong: " + (e?.message || "").slice(0, 80), ms: Date.now() - t0 });
    }
    printRow("T2 seed mismatch", results[results.length - 1]);
  }
  await sleep(800);

  // ── T3: daily variant + NO session → SessionRequired ──
  console.log("\n── T3: daily variant + no session passed → SessionRequired ──");
  {
    const t0 = Date.now();
    try {
      const tx = new Transaction();
      tx.add(...buildUsdcTransferIx(kp.publicKey, treasury));
      tx.add(await buildRecordPaymentIx(program, kp.publicKey, FLIPBALL_GAME_ID));
      tx.add(await buildSubmitScoreIx(
        program, kp.publicKey, FLIPBALL_GAME_ID,
        "daily|2026-06-15", randomSeed(),
        null,                                                            // ← no session
      ));
      await sendAndConfirmTransaction(connection, tx, [kp]);
      results.push({ ok: false, err: "EXPECTED FAILURE but tx succeeded" });
    } catch (e: any) {
      const msg = (e?.message || "").toLowerCase();
      const ok = msg.includes("sessionrequired");
      results.push({ ok, err: ok ? "SessionRequired (expected)" : "wrong: " + (e?.message || "").slice(0, 80), ms: Date.now() - t0 });
    }
    printRow("T3 missing session", results[results.length - 1]);
  }
  await sleep(800);

  // ── T4: EXPIRED session → SessionExpired (optional — needs 65s sleep) ──
  if (!SKIP_T4) {
    console.log("\n── T4: expired session (60s lifetime + 65s sleep) → SessionExpired ──");
    const t0 = Date.now();
    try {
      const nonce = BigInt(Date.now());
      const seed = randomSeed();
      const txOpen = new Transaction();
      txOpen.add(await buildOpenSessionIx(program, kp.publicKey, kp.publicKey, nonce, FLIPBALL_GAME_ID, seed, 60));
      await sendAndConfirmTransaction(connection, txOpen, [kp]);
      console.log("    [T4] sleeping 65s for expiry…");
      await sleep(65_000);

      const tx = new Transaction();
      tx.add(...buildUsdcTransferIx(kp.publicKey, treasury));
      tx.add(await buildRecordPaymentIx(program, kp.publicKey, FLIPBALL_GAME_ID));
      tx.add(await buildSubmitScoreIx(
        program, kp.publicKey, FLIPBALL_GAME_ID,
        "daily|2026-06-15", seed,
        sessionPda(kp.publicKey, nonce),
      ));
      await sendAndConfirmTransaction(connection, tx, [kp]);
      results.push({ ok: false, err: "EXPECTED FAILURE but tx succeeded" });
    } catch (e: any) {
      const msg = (e?.message || "").toLowerCase();
      const ok = msg.includes("sessionexpired");
      results.push({ ok, err: ok ? "SessionExpired (expected)" : "wrong: " + (e?.message || "").slice(0, 80), ms: Date.now() - t0 });
    }
    printRow("T4 expired", results[results.length - 1]);
    await sleep(800);
  } else {
    console.log("\n── T4: SKIPPED (SKIP_T4=1) ──");
  }

  // ── T5: session for OTHER player → SessionOwnerMismatch ──
  console.log("\n── T5: session for OTHER player → SessionOwnerMismatch ──");
  {
    const t0 = Date.now();
    try {
      const other = Keypair.generate();
      const nonce = BigInt(Date.now());
      const seed = randomSeed();
      const txOpen = new Transaction();
      txOpen.add(await buildOpenSessionIx(program, other.publicKey, kp.publicKey, nonce, FLIPBALL_GAME_ID, seed, 3600));
      await sendAndConfirmTransaction(connection, txOpen, [kp]);

      const tx = new Transaction();
      tx.add(...buildUsdcTransferIx(kp.publicKey, treasury));
      tx.add(await buildRecordPaymentIx(program, kp.publicKey, FLIPBALL_GAME_ID));
      tx.add(await buildSubmitScoreIx(
        program, kp.publicKey, FLIPBALL_GAME_ID,
        "daily|2026-06-15", seed,
        sessionPda(other.publicKey, nonce),                              // ← someone else's session
      ));
      await sendAndConfirmTransaction(connection, tx, [kp]);
      results.push({ ok: false, err: "EXPECTED FAILURE but tx succeeded" });
    } catch (e: any) {
      const msg = (e?.message || "").toLowerCase();
      const ok = msg.includes("sessionownermismatch") || msg.includes("ownermismatch");
      results.push({ ok, err: ok ? "SessionOwnerMismatch (expected)" : "wrong: " + (e?.message || "").slice(0, 80), ms: Date.now() - t0 });
    }
    printRow("T5 wrong owner", results[results.length - 1]);
  }
  await sleep(800);

  // ── T6: RANDOM variant + no session → PASS (backwards-compat) ──
  console.log("\n── T6: random variant + no session → PASS (backwards-compat) ──");
  {
    const t0 = Date.now();
    try {
      const tx = new Transaction();
      tx.add(...buildUsdcTransferIx(kp.publicKey, treasury));
      tx.add(await buildRecordPaymentIx(program, kp.publicKey, FLIPBALL_GAME_ID));
      tx.add(await buildSubmitScoreIx(
        program, kp.publicKey, FLIPBALL_GAME_ID,
        "v1_3-stress", randomSeed(),                                     // not daily/challenge
        null,                                                            // no session needed
      ));
      const sig = await sendAndConfirmTransaction(connection, tx, [kp]);
      results.push({ ok: true, sig, ms: Date.now() - t0 });
    } catch (e: any) {
      results.push({ ok: false, err: (e?.message || String(e)).slice(0, 200) });
    }
    printRow("T6 backwards-compat", results[results.length - 1]);
  }

  // ── Summary ──
  console.log("\n═══════════════════════════════════");
  console.log("P0-3 SESSION STRESS RESULTS");
  console.log("═══════════════════════════════════");
  const ok = results.filter((r) => r.ok).length;
  console.log(`${ok}/${results.length} tests pass`);
  const allOk = results.every((r) => r.ok);
  console.log(allOk ? "\n✅ P0-3 GATE PASSED" : "\n❌ P0-3 GATE FAILED");
  process.exit(allOk ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
