#!/usr/bin/env tsx
/**
 * Gamerplex Arcade — v1.3 multi-token stress test
 *
 * Standalone sibling of stress-arcade.ts. T1/T2/T3 are unchanged from v1.2.
 * This script adds:
 *   T4 — multi-mint happy path (5 rotations per player across USDC/SOL/$GAME)
 *   T5 — negative tests (must fail with specific error codes)
 *
 * Prerequisites:
 *   - Contract upgraded to v1.3 on devnet (per migrations/v1_3-upgrade.ts)
 *   - ExchangeRatesConfig PDA initialized with fresh rates
 *   - Player has: devnet USDC + devnet SOL + devnet $GAME tokens
 *
 * Usage:
 *   cd gamerplex-arcade/scripts
 *   npm install
 *   npx tsx stress-arcade-v1_3.ts
 *
 *   # mainnet (requires NETWORK + RPC + funded mainnet keypair)
 *   SOLANA_NETWORK=mainnet SOLANA_RPC=... npx tsx stress-arcade-v1_3.ts
 *
 *   # skip negative tests (just the happy path)
 *   SKIP_T5=1 npx tsx stress-arcade-v1_3.ts
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
  createAssociatedTokenAccountInstruction,
  createTransferCheckedInstruction,
  createMint,
  mintTo,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { AnchorProvider, BN, Program, type Idl } from "@coral-xyz/anchor";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

// ── Config ────────────────────────────────────────────────────────────
const NETWORK = (process.env.SOLANA_NETWORK as "mainnet" | "devnet") || "devnet";
const RPC =
  process.env.SOLANA_RPC ||
  (NETWORK === "mainnet" ? "https://api.mainnet-beta.solana.com" : "https://api.devnet.solana.com");
const KEYPAIR_PATH =
  process.env.KEYPAIR_PATH || (process.env.HOME || "~") + "/.config/solana/id.json";
const SKIP_T5 = !!process.env.SKIP_T5;
const SKIP_T6 = !!process.env.SKIP_T6;
const SKIP_T7 = !!process.env.SKIP_T7;
const SKIP_T8 = !!process.env.SKIP_T8;
const T4_ROUNDS = Number(process.env.T4_ROUNDS || 5);

// Per-network constants
const PROGRAM_ID = new PublicKey("4FVwdxxBp6PTax2tAcPyHE9rYt8tyNf2YBGrSnSqmx8t");
const USDC_MAINNET = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const USDC_DEVNET = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const USDC_MINT = NETWORK === "mainnet" ? USDC_MAINNET : USDC_DEVNET;
const USDT_MAINNET = new PublicKey("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB");
const USDF_MAINNET = new PublicKey("5AMAA9JV9H97YYVxx8F6FsCMmTwXSuTTQneiup4RYAUQ");
const GAME_MAINNET = new PublicKey("7TTBUfDomCKBMemv7FF37Tg3y52cRkAxn8vJnvKD4rsE");
const GAME_DEVNET = new PublicKey("8eGnj5jkW6zTGYieGhtejPjLtGmnKfCdk7FamoJ5LLvD");
const GAME_MINT = NETWORK === "mainnet" ? GAME_MAINNET : GAME_DEVNET;
const SPL_MEMO_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const SOL_NATIVE = PublicKey.default;
const GAME_DECIMALS = 10;
const STABLE_DECIMALS = 6;
const RATE_SCALE_FACTOR = 1_000_000_000_000n;

const SCORE_COMMIT_MICRO_USD = 50_000;     // $0.05 (category 2)
const VERIFIED_COMMIT_MICRO_USD = 150_000; // $0.15 (category 4, matches affiliate threshold)
const CATEGORY_CONTINUE = 0;
const CATEGORY_SCORE_COMMIT = 2;
const CATEGORY_VERIFIED_COMMIT = 4;
const FLIPBALL_GAME_ID = 5;
const CYBER_SNAKE_GAME_ID = 1;
// Dummy Arweave-format external_ref (43 base64url chars) for VerifiedCommit
const DUMMY_AR_REF = "abcdef1234567890ABCDEF1234567890_-abc123XYZW";

// PDAs
const pda = (seeds: (Buffer | Uint8Array)[]) =>
  PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];
const configPda = () => pda([Buffer.from("config")]);
const stablecoinsPda = () => pda([Buffer.from("stablecoins")]);
const ratesPda = () => pda([Buffer.from("rates")]);
const affiliatePda = () => pda([Buffer.from("affiliate")]);
const paymentsPda = () => pda([Buffer.from("payments")]);
const gamePda = (id: number) => pda([Buffer.from("game"), Buffer.from([id])]);
const profilePda = (wallet: PublicKey) =>
  pda([Buffer.from("profile"), wallet.toBuffer()]);

// ── Helpers ───────────────────────────────────────────────────────────
function loadKp(): Keypair {
  const raw = JSON.parse(fs.readFileSync(KEYPAIR_PATH, "utf8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}
function makeNodeWallet(kp: Keypair) {
  return {
    publicKey: kp.publicKey,
    signTransaction: async (tx: any) => { tx.partialSign(kp); return tx; },
    signAllTransactions: async (txs: any[]) => { txs.forEach(t => t.partialSign(kp)); return txs; },
  };
}
function randomSeed(): Uint8Array {
  return new Uint8Array(crypto.randomBytes(32));
}
function sha256(data: Uint8Array): Uint8Array {
  return new Uint8Array(crypto.createHash("sha256").update(data).digest());
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Convert raw amount via on-chain scaled rate
function convertUsdToRaw(amountMicroUsd: number, rateScaled: bigint): bigint {
  return (BigInt(amountMicroUsd) * RATE_SCALE_FACTOR) / rateScaled;
}
function applyOverpay(raw: bigint, bps = 50n): bigint {
  return (raw * (10_000n + bps)) / 10_000n;
}

type Result = { ok: boolean; sig?: string; err?: string; ms?: number };
const printRow = (label: string, r: Result) => {
  const status = r.ok ? "✅" : "❌";
  const t = r.ok && r.ms !== undefined ? `${r.ms}ms` : "";
  const info = r.ok ? r.sig?.slice(0, 20) + "…" : r.err?.slice(0, 80);
  console.log(`  ${status} ${label.padEnd(28)} ${t.padEnd(8)} ${info}`);
};

// ── Build helpers (mirror gamerplex-com client.ts) ────────────────────
async function buildRecordPaymentIx(
  program: Program,
  player: PublicKey,
  args: {
    category: number;
    amountMicroUsd: BN;
    paymentMint: PublicKey;
    paymentAmountRaw: BN;
    externalRef: string;
    gameId: number;
    referrer?: PublicKey;
  },
) {
  return (program.methods as any)
    .recordPayment(
      args.category,
      args.amountMicroUsd,
      args.paymentMint,
      args.paymentAmountRaw,
      Array.from(new Uint8Array(64)),
      args.externalRef,
    )
    .accounts({
      config: configPda(),
      stablecoinConfig: stablecoinsPda(),
      game: gamePda(args.gameId),
      profile: profilePda(player),
      wallet: player,
      referrerProfile: args.referrer ? profilePda(args.referrer) : null,
      rates: ratesPda(),
      affiliateConfig: affiliatePda(),
      paymentsConfig: paymentsPda(),
      player,
      instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
    })
    .instruction();
}

// Open a player profile. Idempotent: skips if already open.
async function ensureProfile(
  program: Program,
  connection: Connection,
  signer: Keypair,
  referrer: PublicKey,
) {
  const profileAddr = profilePda(signer.publicKey);
  const info = await connection.getAccountInfo(profileAddr);
  if (info) return;
  const refProfile = referrer.equals(PublicKey.default) ? null : profilePda(referrer);
  const ix = await (program.methods as any)
    .openPlayerProfile(referrer)
    .accounts({
      config: configPda(),
      profile: profileAddr,
      referrerProfile: refProfile,
      player: signer.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
  await sendAndConfirmTransaction(connection, new Transaction().add(ix), [signer]);
}

// Fund an ephemeral wallet with SOL from the main keypair.
async function fundFromMain(
  connection: Connection,
  funder: Keypair,
  recipient: PublicKey,
  lamports: number,
) {
  const tx = new Transaction().add(SystemProgram.transfer({
    fromPubkey: funder.publicKey, toPubkey: recipient, lamports,
  }));
  await sendAndConfirmTransaction(connection, tx, [funder]);
}

// Transfer SPL tokens from main wallet to ephemeral wallet's ATA.
async function transferSplToEphemeral(
  connection: Connection,
  funder: Keypair,
  recipient: PublicKey,
  mint: PublicKey,
  amountRaw: bigint,
  decimals: number,
) {
  const fromAta = getAssociatedTokenAddressSync(mint, funder.publicKey);
  const toAta = getAssociatedTokenAddressSync(mint, recipient);
  const tx = new Transaction();
  if (!(await connection.getAccountInfo(toAta))) {
    tx.add(createAssociatedTokenAccountInstruction(funder.publicKey, toAta, recipient, mint));
  }
  tx.add(createTransferCheckedInstruction(
    fromAta, mint, toAta, funder.publicKey, amountRaw, decimals, [], TOKEN_PROGRAM_ID,
  ));
  await sendAndConfirmTransaction(connection, tx, [funder]);
}

// Parse logs for an emitted event name (works for Anchor `emit!` events).
function logsContainEvent(logs: string[], name: string): boolean {
  return logs.some((l) => l.includes(name));
}

async function buildSubmitScoreIx(
  program: Program,
  player: PublicKey,
  gameId: number,
  score: number,
) {
  return (program.methods as any)
    .submitScore(
      "v1_3-stress",
      new BN(score),
      0,
      0,
      Array.from(randomSeed()),
      30,
      Array.from(sha256(new Uint8Array(0))),
      "",
      PublicKey.default,
    )
    .accounts({
      config: configPda(),
      game: gamePda(gameId),
      profile: profilePda(player),
      wallet: player,
      player,
      memoProgram: SPL_MEMO_ID,
      instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      // P0-3: session is Optional<Account> — required only for daily/challenge
      // variants. "v1_3-stress" doesn't need one, but Anchor needs it explicit.
      session: null,
    })
    .instruction();
}

// ── Main ──────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n=== v1.3 Multi-Token Stress (${NETWORK}) ===`);
  console.log(`  Program: ${PROGRAM_ID.toBase58()}`);
  console.log(`  RPC:     ${RPC}\n`);

  const kp = loadKp();
  console.log(`Wallet: ${kp.publicKey.toBase58()}`);
  const connection = new Connection(RPC, "confirmed");
  const provider = new AnchorProvider(connection, makeNodeWallet(kp) as any, {
    commitment: "confirmed",
  });

  const idlPath = path.join(__dirname, "..", "target", "idl", "gamerplex_arcade.json");
  if (!fs.existsSync(idlPath)) {
    console.error(`IDL missing: ${idlPath}. Run anchor build first.`);
    process.exit(1);
  }
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf8")) as Idl;
  const program = new Program(idl, provider);

  // Sanity: rates PDA exists?
  const ratesAddr = ratesPda();
  const ratesInfo = await connection.getAccountInfo(ratesAddr);
  if (!ratesInfo) {
    console.error("ExchangeRatesConfig PDA missing. Run migrations/v1_3-upgrade.ts first.");
    process.exit(1);
  }
  const rates: any = await (program.account as any).exchangeRatesConfig.fetch(ratesAddr);
  console.log(`Rates: SOL=${rates.solMicroUsdPerLamport.toString()} GAME=${rates.gameMicroUsdPerQuark.toString()}\n`);

  // Sanity: treasury wallet
  const cfg: any = await (program.account as any).arcadeConfig.fetch(configPda());
  const treasury = cfg.treasuryWallet as PublicKey;
  console.log(`Treasury: ${treasury.toBase58()}\n`);

  // ── T4: multi-mint rotation ─────────────────────────────────────────
  console.log(`── T4: ${T4_ROUNDS} rounds × 3 mints (USDC / SOL / $GAME) ──`);
  const t4Results: Result[] = [];

  for (let round = 0; round < T4_ROUNDS; round++) {
    for (const mint of [USDC_MINT, SOL_NATIVE, GAME_MINT] as const) {
      const label =
        mint.equals(SOL_NATIVE) ? "SOL" :
        mint.equals(GAME_MINT) ? "GAME" :
        mint.equals(USDC_MINT) ? "USDC" : mint.toBase58().slice(0, 4);

      const t0 = Date.now();
      try {
        const tx = new Transaction();
        const base = SCORE_COMMIT_MICRO_USD;
        let paymentAmountRaw: BN;
        let amountMicroUsdToRecord: number;

        if (mint.equals(SOL_NATIVE)) {
          const expected = convertUsdToRaw(base, BigInt(rates.solMicroUsdPerLamport.toString()));
          const lamports = applyOverpay(expected);
          paymentAmountRaw = new BN(lamports.toString());
          amountMicroUsdToRecord = base;
          tx.add(SystemProgram.transfer({
            fromPubkey: kp.publicKey,
            toPubkey: treasury,
            lamports: Number(lamports),
          }));
        } else if (mint.equals(GAME_MINT)) {
          // v1.4: contract enforces amount_micro_usd == base * 0.8 for $GAME (the
          // user-facing 20% discount). Both declared USD and actual token amount
          // shrink to 80% of standard.
          const discountedUsd = Math.floor((base * 80) / 100);
          const expected = convertUsdToRaw(discountedUsd, BigInt(rates.gameMicroUsdPerQuark.toString()));
          const quarks = applyOverpay(expected);
          paymentAmountRaw = new BN(quarks.toString());
          amountMicroUsdToRecord = discountedUsd;
          const fromAta = getAssociatedTokenAddressSync(GAME_MINT, kp.publicKey);
          const toAta = getAssociatedTokenAddressSync(GAME_MINT, treasury);
          const toInfo = await connection.getAccountInfo(toAta);
          if (!toInfo) tx.add(createAssociatedTokenAccountInstruction(kp.publicKey, toAta, treasury, GAME_MINT));
          tx.add(createTransferCheckedInstruction(
            fromAta, GAME_MINT, toAta, kp.publicKey,
            BigInt(quarks.toString()), GAME_DECIMALS, [], TOKEN_PROGRAM_ID,
          ));
        } else {
          // Stablecoin: parity (raw === micro-USD)
          paymentAmountRaw = new BN(base);
          amountMicroUsdToRecord = base;
          const fromAta = getAssociatedTokenAddressSync(mint, kp.publicKey);
          const toAta = getAssociatedTokenAddressSync(mint, treasury);
          const toInfo = await connection.getAccountInfo(toAta);
          if (!toInfo) tx.add(createAssociatedTokenAccountInstruction(kp.publicKey, toAta, treasury, mint));
          tx.add(createTransferCheckedInstruction(
            fromAta, mint, toAta, kp.publicKey,
            BigInt(base), STABLE_DECIMALS, [], TOKEN_PROGRAM_ID,
          ));
        }

        tx.add(await buildRecordPaymentIx(program, kp.publicKey, {
          category: CATEGORY_SCORE_COMMIT,
          amountMicroUsd: new BN(amountMicroUsdToRecord),
          paymentMint: mint,
          paymentAmountRaw,
          externalRef: "",
          gameId: FLIPBALL_GAME_ID,
        }));

        tx.add(await buildSubmitScoreIx(program, kp.publicKey, FLIPBALL_GAME_ID, 1000 + round * 100));

        const sig = await sendAndConfirmTransaction(connection, tx, [kp]);
        t4Results.push({ ok: true, sig, ms: Date.now() - t0 });
        printRow(`T4 R${round + 1} ${label}`, t4Results[t4Results.length - 1]);
      } catch (e: any) {
        const errMsg = (e?.message || String(e)).slice(0, 120);
        t4Results.push({ ok: false, err: errMsg });
        printRow(`T4 R${round + 1} ${label}`, t4Results[t4Results.length - 1]);
      }
      await sleep(600);
    }
  }

  // ── T5: negative tests (must fail with specific error codes) ────────
  const t5Results: Result[] = [];
  if (!SKIP_T5) {
    console.log(`\n── T5: negative tests (each must FAIL with expected error) ──`);

    // T5b — SOL underpaid past slippage
    {
      const t0 = Date.now();
      try {
        const tx = new Transaction();
        const base = SCORE_COMMIT_MICRO_USD;
        const expected = convertUsdToRaw(base, BigInt(rates.solMicroUsdPerLamport.toString()));
        const underpayLamports = (expected * 90n) / 100n; // 10% underpay — far past 1% floor
        tx.add(SystemProgram.transfer({
          fromPubkey: kp.publicKey,
          toPubkey: treasury,
          lamports: Number(underpayLamports),
        }));
        tx.add(await buildRecordPaymentIx(program, kp.publicKey, {
          category: CATEGORY_SCORE_COMMIT,
          amountMicroUsd: new BN(base),
          paymentMint: SOL_NATIVE,
          paymentAmountRaw: new BN(underpayLamports.toString()),
          externalRef: "",
          gameId: FLIPBALL_GAME_ID,
        }));
        await sendAndConfirmTransaction(connection, tx, [kp]);
        // Should NOT reach here
        t5Results.push({ ok: false, err: "EXPECTED FAILURE but tx succeeded" });
      } catch (e: any) {
        const ok = (e?.message || "").includes("PaymentUnderpaid") ||
                   (e?.message || "").toLowerCase().includes("underpaid");
        t5Results.push({
          ok,
          err: ok ? "PaymentUnderpaid (expected)" : "wrong error: " + (e?.message || "").slice(0, 80),
          ms: Date.now() - t0,
        });
      }
      printRow("T5b SOL underpaid", t5Results[t5Results.length - 1]);
      await sleep(800);
    }

    // T5d — $GAME underpaid past slippage (v1.4: amount_micro_usd uses discounted)
    {
      const t0 = Date.now();
      try {
        const tx = new Transaction();
        const base = SCORE_COMMIT_MICRO_USD;
        const discountedUsd = Math.floor((base * 80) / 100);
        const expected = convertUsdToRaw(discountedUsd, BigInt(rates.gameMicroUsdPerQuark.toString()));
        const underpayQuarks = (expected * 90n) / 100n; // 10% underpay (past 0.5% slippage)
        const fromAta = getAssociatedTokenAddressSync(GAME_MINT, kp.publicKey);
        const toAta = getAssociatedTokenAddressSync(GAME_MINT, treasury);
        tx.add(createTransferCheckedInstruction(
          fromAta, GAME_MINT, toAta, kp.publicKey,
          BigInt(underpayQuarks.toString()), GAME_DECIMALS, [], TOKEN_PROGRAM_ID,
        ));
        tx.add(await buildRecordPaymentIx(program, kp.publicKey, {
          category: CATEGORY_SCORE_COMMIT,
          amountMicroUsd: new BN(discountedUsd),
          paymentMint: GAME_MINT,
          paymentAmountRaw: new BN(underpayQuarks.toString()),
          externalRef: "",
          gameId: FLIPBALL_GAME_ID,
        }));
        await sendAndConfirmTransaction(connection, tx, [kp]);
        t5Results.push({ ok: false, err: "EXPECTED FAILURE but tx succeeded" });
      } catch (e: any) {
        const msg = (e?.message || "").toLowerCase();
        const ok = msg.includes("paymentunderpaid") || msg.includes("underpaid");
        t5Results.push({
          ok,
          err: ok ? "PaymentUnderpaid (expected)" : "wrong error: " + (e?.message || "").slice(0, 80),
          ms: Date.now() - t0,
        });
      }
      printRow("T5d $GAME underpaid", t5Results[t5Results.length - 1]);
      await sleep(800);
    }

    // T5c — wrong stablecoin mint (create a fresh random mint, try to use it)
    if (NETWORK === "devnet") {
      const t0 = Date.now();
      try {
        console.log("    [T5c] creating fresh random mint...");
        const fakeMint = await createMint(connection, kp, kp.publicKey, null, 6);
        const fakeAta = getAssociatedTokenAddressSync(fakeMint, kp.publicKey);
        await mintTo(connection, kp, fakeMint, fakeAta, kp.publicKey, 100_000_000n);
        const toAta = getAssociatedTokenAddressSync(fakeMint, treasury);

        const tx = new Transaction();
        tx.add(createAssociatedTokenAccountInstruction(kp.publicKey, toAta, treasury, fakeMint));
        tx.add(createTransferCheckedInstruction(
          fakeAta, fakeMint, toAta, kp.publicKey,
          BigInt(SCORE_COMMIT_MICRO_USD), 6, [], TOKEN_PROGRAM_ID,
        ));
        tx.add(await buildRecordPaymentIx(program, kp.publicKey, {
          category: CATEGORY_SCORE_COMMIT,
          amountMicroUsd: new BN(SCORE_COMMIT_MICRO_USD),
          paymentMint: fakeMint,
          paymentAmountRaw: new BN(SCORE_COMMIT_MICRO_USD),
          externalRef: "",
          gameId: FLIPBALL_GAME_ID,
        }));
        await sendAndConfirmTransaction(connection, tx, [kp]);
        t5Results.push({ ok: false, err: "EXPECTED FAILURE but tx succeeded" });
      } catch (e: any) {
        const msg = (e?.message || "").toLowerCase();
        const ok = msg.includes("paymentmintnotallowed") || msg.includes("mintnotallowed");
        t5Results.push({
          ok,
          err: ok ? "PaymentMintNotAllowed (expected)" : "wrong error: " + (e?.message || "").slice(0, 80),
          ms: Date.now() - t0,
        });
      }
      printRow("T5c fake stablecoin", t5Results[t5Results.length - 1]);
      await sleep(800);
    } else {
      console.log("    [T5c] SKIPPED on mainnet (don't burn real SOL on test mints)");
    }

    // T5f — decimals mismatch (try to pay USDC declaring decimals=9 instead of 6)
    {
      const t0 = Date.now();
      try {
        const tx = new Transaction();
        const fromAta = getAssociatedTokenAddressSync(USDC_MINT, kp.publicKey);
        const toAta = getAssociatedTokenAddressSync(USDC_MINT, treasury);
        // TransferChecked with WRONG decimals byte — contract enforces data[9] == 6
        tx.add(createTransferCheckedInstruction(
          fromAta, USDC_MINT, toAta, kp.publicKey,
          BigInt(SCORE_COMMIT_MICRO_USD), 9, [], TOKEN_PROGRAM_ID, // 9 != 6 → mismatch
        ));
        tx.add(await buildRecordPaymentIx(program, kp.publicKey, {
          category: CATEGORY_SCORE_COMMIT,
          amountMicroUsd: new BN(SCORE_COMMIT_MICRO_USD),
          paymentMint: USDC_MINT,
          paymentAmountRaw: new BN(SCORE_COMMIT_MICRO_USD),
          externalRef: "",
          gameId: FLIPBALL_GAME_ID,
        }));
        await sendAndConfirmTransaction(connection, tx, [kp]);
        t5Results.push({ ok: false, err: "EXPECTED FAILURE but tx succeeded" });
      } catch (e: any) {
        const msg = (e?.message || "").toLowerCase();
        // SPL TransferChecked rejects internally with TokenMismatch when decimals don't match,
        // OR our contract rejects with DecimalsMismatch — both are valid failure modes
        const ok = msg.includes("decimalsmismatch") ||
                   msg.includes("token mismatch") ||
                   msg.includes("0x3");
        t5Results.push({
          ok,
          err: ok ? "decimals rejected (expected)" : "wrong error: " + (e?.message || "").slice(0, 80),
          ms: Date.now() - t0,
        });
      }
      printRow("T5f decimals mismatch", t5Results[t5Results.length - 1]);
    }

    // T5a (stale rate) + T5e (forged-mint pubkey collision) — DOCUMENTED MANUAL TESTS
    console.log(`
    [T5a] SOL stale rate — MANUAL: stop oracle bot for >1hr, then try SOL pay.
                                    Must fail with ExchangeRateStale.
    [T5e] Forged mint pubkey — MANUAL: requires finding a colliding mint pubkey
                                    (cryptographically infeasible). Skip; defended
                                    by cfg(feature="mainnet") compile-time constant.`);
  }

  // ── T6: affiliate flow (min-threshold + accrual + kill-switch) ──────
  const t6Results: Result[] = [];
  if (!SKIP_T6) {
    console.log(`\n── T6: affiliate (min-threshold + accrual + kill-switch) ──`);

    // Ephemeral referrer + player so the test is self-contained and reusable.
    // Referrer needs profile (rent ~0.0014 SOL). Player needs SOL fees + USDC
    // for 4 payments at up to $0.15 each = $0.60.
    const refKp = Keypair.generate();
    const playerKp = Keypair.generate();
    console.log(`    refr:   ${refKp.publicKey.toBase58().slice(0, 12)}…`);
    console.log(`    player: ${playerKp.publicKey.toBase58().slice(0, 12)}…`);

    try {
      // Fund both wallets from main keypair
      await fundFromMain(connection, kp, refKp.publicKey, 5_000_000);     // 0.005 SOL — profile rent
      await fundFromMain(connection, kp, playerKp.publicKey, 20_000_000); // 0.02 SOL — fees + token rent
      await transferSplToEphemeral(connection, kp, playerKp.publicKey, USDC_MINT, 800_000n, STABLE_DECIMALS); // $0.80 USDC
      await sleep(800);

      // Open profiles (referrer has no referrer; player references refKp)
      await ensureProfile(program, connection, refKp, PublicKey.default);
      await ensureProfile(program, connection, playerKp, refKp.publicKey);
      await sleep(600);

      // Read current affiliate config (admin = main kp)
      const affCfg: any = await (program.account as any).affiliateConfig.fetch(affiliatePda());
      const minMicro = Number(affCfg.minAccrualMicro.toString());
      console.log(`    affiliate min: $${(minMicro / 1_000_000).toFixed(4)}, disabled: ${affCfg.disabled}`);

      const payWithRef = async (amountMicro: number, category: number, label: string, expectAccrual: boolean) => {
        const t0 = Date.now();
        try {
          const tx = new Transaction();
          const fromAta = getAssociatedTokenAddressSync(USDC_MINT, playerKp.publicKey);
          const toAta = getAssociatedTokenAddressSync(USDC_MINT, treasury);
          if (!(await connection.getAccountInfo(toAta))) {
            tx.add(createAssociatedTokenAccountInstruction(playerKp.publicKey, toAta, treasury, USDC_MINT));
          }
          tx.add(createTransferCheckedInstruction(
            fromAta, USDC_MINT, toAta, playerKp.publicKey,
            BigInt(amountMicro), STABLE_DECIMALS, [], TOKEN_PROGRAM_ID,
          ));
          tx.add(await buildRecordPaymentIx(program, playerKp.publicKey, {
            category,
            amountMicroUsd: new BN(amountMicro),
            paymentMint: USDC_MINT,
            paymentAmountRaw: new BN(amountMicro),
            externalRef: category === CATEGORY_VERIFIED_COMMIT ? DUMMY_AR_REF : "",
            gameId: FLIPBALL_GAME_ID,
            referrer: refKp.publicKey,
          }));
          // Skip submit_score for VerifiedCommit since it has its own session-replay flow
          if (category === CATEGORY_SCORE_COMMIT) {
            tx.add(await buildSubmitScoreIx(program, playerKp.publicKey, FLIPBALL_GAME_ID, 1000));
          }
          const sig = await sendAndConfirmTransaction(connection, tx, [playerKp]);
          await sleep(1200);
          const txInfo = await connection.getParsedTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
          const logs = txInfo?.meta?.logMessages || [];
          const sawAccrual = logsContainEvent(logs, "AffiliateAccrued");
          const ok = sawAccrual === expectAccrual;
          t6Results.push({
            ok,
            sig,
            err: ok ? undefined : `expected accrual=${expectAccrual} got=${sawAccrual}`,
            ms: Date.now() - t0,
          });
          printRow(label, t6Results[t6Results.length - 1]);
        } catch (e: any) {
          t6Results.push({ ok: false, err: (e?.message || String(e)).slice(0, 120) });
          printRow(label, t6Results[t6Results.length - 1]);
        }
      };

      // T6a — $0.05 ScoreCommit (below threshold) → NO AffiliateAccrued
      await payWithRef(SCORE_COMMIT_MICRO_USD, CATEGORY_SCORE_COMMIT, "T6a $0.05 below-threshold (no accrual)", false);
      await sleep(800);

      // T6b — $0.15 VerifiedCommit (at threshold) → AffiliateAccrued fires
      await payWithRef(VERIFIED_COMMIT_MICRO_USD, CATEGORY_VERIFIED_COMMIT, "T6b $0.15 at-threshold (accrual fires)", true);
      await sleep(800);

      // T6c — kill switch off, then $0.15 VerifiedCommit → NO accrual
      const nowSec = Math.floor(Date.now() / 1000);
      const deadline = nowSec + 300;
      try {
        const killTx = new Transaction().add(
          await (program.methods as any)
            .setAffiliateEnabled(false, new BN(deadline))
            .accounts({ affiliateConfig: affiliatePda(), admin: kp.publicKey })
            .instruction()
        );
        await sendAndConfirmTransaction(connection, killTx, [kp]);
        console.log("    [T6c] kill-switch flipped OFF");
      } catch (e: any) {
        console.log(`    [T6c] kill-switch failed: ${e?.message?.slice(0, 100)}`);
      }
      await sleep(600);
      await payWithRef(VERIFIED_COMMIT_MICRO_USD, CATEGORY_VERIFIED_COMMIT, "T6c $0.15 with kill-switch (no accrual)", false);
      await sleep(800);

      // T6d — restore kill switch ON, verify accrual resumes
      try {
        const restoreTx = new Transaction().add(
          await (program.methods as any)
            .setAffiliateEnabled(true, new BN(Math.floor(Date.now() / 1000) + 300))
            .accounts({ affiliateConfig: affiliatePda(), admin: kp.publicKey })
            .instruction()
        );
        await sendAndConfirmTransaction(connection, restoreTx, [kp]);
        console.log("    [T6d] kill-switch restored ON");
      } catch (e: any) {
        console.log(`    [T6d] kill-switch restore failed: ${e?.message?.slice(0, 100)}`);
      }
      await sleep(600);
      await payWithRef(VERIFIED_COMMIT_MICRO_USD, CATEGORY_VERIFIED_COMMIT, "T6d $0.15 kill-switch restored (accrual)", true);

      // Verify referrer profile accrued total
      const refProfile: any = await (program.account as any).playerProfile.fetch(profilePda(refKp.publicKey));
      console.log(`    referrer accrued total: ${refProfile.affiliateAccruedMicro?.toString() || "(field missing)"}`);
    } catch (e: any) {
      console.error(`    T6 setup failed: ${e?.message?.slice(0, 200)}`);
      t6Results.push({ ok: false, err: "setup failed" });
    }
  }

  // ── T7: ALL games via shared arcade client (cross-game state isolation) ──
  const t7Results: Result[] = [];
  if (!SKIP_T7) {
    console.log(`\n── T7: all 4 active games × USDC save-score (same wallet) ──`);
    const allGames: Array<{ id: number; slug: string }> = [
      { id: 1, slug: "cyber-snake" },
      { id: 3, slug: "magic-chess" },
      { id: 4, slug: "blockwords" },
      { id: 5, slug: "flipball" },
    ];
    for (const game of allGames) {
      const registered = await connection.getAccountInfo(gamePda(game.id));
      if (!registered) {
        console.log(`    [T7] game_id=${game.id} (${game.slug}) NOT registered on this network — SKIPPED`);
        t7Results.push({ ok: false, err: "not registered" });
        printRow(`T7 ${game.slug} (id=${game.id})`, t7Results[t7Results.length - 1]);
        continue;
      }
      const t0 = Date.now();
      try {
        const tx = new Transaction();
        const fromAta = getAssociatedTokenAddressSync(USDC_MINT, kp.publicKey);
        const toAta = getAssociatedTokenAddressSync(USDC_MINT, treasury);
        tx.add(createTransferCheckedInstruction(
          fromAta, USDC_MINT, toAta, kp.publicKey,
          BigInt(SCORE_COMMIT_MICRO_USD), STABLE_DECIMALS, [], TOKEN_PROGRAM_ID,
        ));
        tx.add(await buildRecordPaymentIx(program, kp.publicKey, {
          category: CATEGORY_SCORE_COMMIT,
          amountMicroUsd: new BN(SCORE_COMMIT_MICRO_USD),
          paymentMint: USDC_MINT,
          paymentAmountRaw: new BN(SCORE_COMMIT_MICRO_USD),
          externalRef: "",
          gameId: game.id,
        }));
        tx.add(await buildSubmitScoreIx(program, kp.publicKey, game.id, 4321));
        const sig = await sendAndConfirmTransaction(connection, tx, [kp]);
        t7Results.push({ ok: true, sig, ms: Date.now() - t0 });
      } catch (e: any) {
        if (process.env.DEBUG_LOGS) console.error(`\n[T7 ${game.slug}] FULL ERROR:`, e?.message, "\nLOGS:\n" + ((e?.logs || []).join("\n") || "(no logs prop)"));
        t7Results.push({ ok: false, err: (e?.message || String(e)).slice(0, 120) });
      }
      printRow(`T7 ${game.slug} (id=${game.id})`, t7Results[t7Results.length - 1]);
      await sleep(700);
    }
  }

  // ── T8: P0-2 payment-gate negative tests (each must FAIL) ────────────
  const t8Results: Result[] = [];
  if (!SKIP_T8) {
    console.log(`\n── T8: P0-2 submit_score payment-gate (each must FAIL) ──`);

    // T8a — submit_score WITHOUT paired record_payment
    {
      const t0 = Date.now();
      try {
        const tx = new Transaction();
        tx.add(await buildSubmitScoreIx(program, kp.publicKey, FLIPBALL_GAME_ID, 1234));
        await sendAndConfirmTransaction(connection, tx, [kp]);
        t8Results.push({ ok: false, err: "EXPECTED FAILURE but tx succeeded" });
      } catch (e: any) {
        const msg = (e?.message || "").toLowerCase();
        const ok = msg.includes("requiredpaymentmissing") || msg.includes("payment");
        t8Results.push({
          ok,
          err: ok ? "RequiredPaymentMissing (expected)" : "wrong error: " + (e?.message || "").slice(0, 80),
          ms: Date.now() - t0,
        });
      }
      printRow("T8a no payment", t8Results[t8Results.length - 1]);
      await sleep(800);
    }

    // T8b — submit_score with WRONG category (CONTINUE instead of SCORE_COMMIT)
    {
      const t0 = Date.now();
      try {
        const tx = new Transaction();
        const fromAta = getAssociatedTokenAddressSync(USDC_MINT, kp.publicKey);
        const toAta = getAssociatedTokenAddressSync(USDC_MINT, treasury);
        tx.add(createTransferCheckedInstruction(
          fromAta, USDC_MINT, toAta, kp.publicKey,
          BigInt(SCORE_COMMIT_MICRO_USD), STABLE_DECIMALS, [], TOKEN_PROGRAM_ID,
        ));
        tx.add(await buildRecordPaymentIx(program, kp.publicKey, {
          category: CATEGORY_CONTINUE,            // wrong — submit_score wants SCORE_COMMIT
          amountMicroUsd: new BN(SCORE_COMMIT_MICRO_USD),
          paymentMint: USDC_MINT,
          paymentAmountRaw: new BN(SCORE_COMMIT_MICRO_USD),
          externalRef: "",
          gameId: FLIPBALL_GAME_ID,
        }));
        tx.add(await buildSubmitScoreIx(program, kp.publicKey, FLIPBALL_GAME_ID, 1234));
        await sendAndConfirmTransaction(connection, tx, [kp]);
        t8Results.push({ ok: false, err: "EXPECTED FAILURE but tx succeeded" });
      } catch (e: any) {
        const msg = (e?.message || "").toLowerCase();
        const ok = msg.includes("requiredpaymentmissing") || msg.includes("payment");
        t8Results.push({
          ok,
          err: ok ? "RequiredPaymentMissing (expected — wrong category)" : "wrong error: " + (e?.message || "").slice(0, 80),
          ms: Date.now() - t0,
        });
      }
      printRow("T8b wrong category", t8Results[t8Results.length - 1]);
      await sleep(800);
    }

    // T8c — submit_score with WRONG amount ($0.04 instead of $0.05)
    {
      const t0 = Date.now();
      try {
        const wrongAmount = SCORE_COMMIT_MICRO_USD - 10_000; // $0.04
        const tx = new Transaction();
        const fromAta = getAssociatedTokenAddressSync(USDC_MINT, kp.publicKey);
        const toAta = getAssociatedTokenAddressSync(USDC_MINT, treasury);
        tx.add(createTransferCheckedInstruction(
          fromAta, USDC_MINT, toAta, kp.publicKey,
          BigInt(wrongAmount), STABLE_DECIMALS, [], TOKEN_PROGRAM_ID,
        ));
        tx.add(await buildRecordPaymentIx(program, kp.publicKey, {
          category: CATEGORY_SCORE_COMMIT,
          amountMicroUsd: new BN(wrongAmount),     // wrong — sysvar check is exact-match
          paymentMint: USDC_MINT,
          paymentAmountRaw: new BN(wrongAmount),
          externalRef: "",
          gameId: FLIPBALL_GAME_ID,
        }));
        tx.add(await buildSubmitScoreIx(program, kp.publicKey, FLIPBALL_GAME_ID, 1234));
        await sendAndConfirmTransaction(connection, tx, [kp]);
        t8Results.push({ ok: false, err: "EXPECTED FAILURE but tx succeeded" });
      } catch (e: any) {
        const msg = (e?.message || "").toLowerCase();
        const ok = msg.includes("requiredpaymentmissing") ||
                   msg.includes("payment") ||
                   msg.includes("amount");
        t8Results.push({
          ok,
          err: ok ? "RequiredPaymentMissing (expected — wrong amount)" : "wrong error: " + (e?.message || "").slice(0, 80),
          ms: Date.now() - t0,
        });
      }
      printRow("T8c wrong amount", t8Results[t8Results.length - 1]);
      await sleep(800);
    }

    // T8d — TWO submit_score in same tx with ONE record_payment → DuplicateIxInTx
    {
      const t0 = Date.now();
      try {
        const tx = new Transaction();
        const fromAta = getAssociatedTokenAddressSync(USDC_MINT, kp.publicKey);
        const toAta = getAssociatedTokenAddressSync(USDC_MINT, treasury);
        tx.add(createTransferCheckedInstruction(
          fromAta, USDC_MINT, toAta, kp.publicKey,
          BigInt(SCORE_COMMIT_MICRO_USD), STABLE_DECIMALS, [], TOKEN_PROGRAM_ID,
        ));
        tx.add(await buildRecordPaymentIx(program, kp.publicKey, {
          category: CATEGORY_SCORE_COMMIT,
          amountMicroUsd: new BN(SCORE_COMMIT_MICRO_USD),
          paymentMint: USDC_MINT,
          paymentAmountRaw: new BN(SCORE_COMMIT_MICRO_USD),
          externalRef: "",
          gameId: FLIPBALL_GAME_ID,
        }));
        tx.add(await buildSubmitScoreIx(program, kp.publicKey, FLIPBALL_GAME_ID, 1111));
        tx.add(await buildSubmitScoreIx(program, kp.publicKey, FLIPBALL_GAME_ID, 2222)); // 2nd
        await sendAndConfirmTransaction(connection, tx, [kp]);
        t8Results.push({ ok: false, err: "EXPECTED FAILURE but tx succeeded" });
      } catch (e: any) {
        const msg = (e?.message || "").toLowerCase();
        const ok = msg.includes("duplicateixintx") || msg.includes("duplicate");
        t8Results.push({
          ok,
          err: ok ? "DuplicateIxInTx (expected)" : "wrong error: " + (e?.message || "").slice(0, 80),
          ms: Date.now() - t0,
        });
      }
      printRow("T8d duplicate submit", t8Results[t8Results.length - 1]);
    }
  }

  // ── T9: global payments kill-switch (PaymentsConfig) ──────────────────
  const t9Results: Result[] = [];
  const SKIP_T9 = process.env.SKIP_T9 === "1";
  if (!SKIP_T9) {
    console.log(`\n── T9: payments kill-switch (pause blocks record_payment) ──`);
    const setPaused = async (paused: boolean, signer = kp) => {
      const tx = new Transaction().add(
        await (program.methods as any)
          .setPaymentsPaused(paused, new BN(Math.floor(Date.now() / 1000) + 300))
          .accounts({ config: configPda(), paymentsConfig: paymentsPda(), admin: signer.publicKey })
          .instruction()
      );
      tx.feePayer = kp.publicKey;
      const signers = signer.publicKey.equals(kp.publicKey) ? [kp] : [kp, signer];
      return sendAndConfirmTransaction(connection, tx, signers);
    };
    const trySave = async () => {
      const tx = new Transaction();
      const fromAta = getAssociatedTokenAddressSync(USDC_MINT, kp.publicKey);
      const toAta = getAssociatedTokenAddressSync(USDC_MINT, treasury);
      tx.add(createTransferCheckedInstruction(
        fromAta, USDC_MINT, toAta, kp.publicKey,
        BigInt(SCORE_COMMIT_MICRO_USD), STABLE_DECIMALS, [], TOKEN_PROGRAM_ID,
      ));
      tx.add(await buildRecordPaymentIx(program, kp.publicKey, {
        category: CATEGORY_SCORE_COMMIT,
        amountMicroUsd: new BN(SCORE_COMMIT_MICRO_USD),
        paymentMint: USDC_MINT,
        paymentAmountRaw: new BN(SCORE_COMMIT_MICRO_USD),
        externalRef: "",
        gameId: FLIPBALL_GAME_ID,
      }));
      return sendAndConfirmTransaction(connection, tx, [kp]);
    };

    // T9a — pause → record_payment rejected with PaymentsPaused
    try {
      await setPaused(true);
      await sleep(600);
      try {
        await trySave();
        t9Results.push({ ok: false, err: "EXPECTED FAILURE but save succeeded while paused" });
      } catch (e: any) {
        const m = (e?.message || "").toLowerCase();
        const ok = m.includes("paymentspaused") || m.includes("paused");
        t9Results.push({ ok, err: ok ? "PaymentsPaused (expected)" : "wrong error: " + (e?.message || "").slice(0, 80) });
      }
    } catch (e: any) {
      t9Results.push({ ok: false, err: "pause failed: " + (e?.message || "").slice(0, 80) });
    }
    printRow("T9a paused → reject", t9Results[t9Results.length - 1]);
    await sleep(600);

    // T9b — unpause → save succeeds again
    try {
      await setPaused(false);
      await sleep(600);
      await trySave();
      t9Results.push({ ok: true, err: "save ok after unpause" });
    } catch (e: any) {
      t9Results.push({ ok: false, err: "save failed after unpause: " + (e?.message || "").slice(0, 80) });
    }
    printRow("T9b unpaused → ok", t9Results[t9Results.length - 1]);
    await sleep(600);

    // T9c — non-admin set_payments_paused → AdminOnly
    {
      const badKp = Keypair.generate();
      try {
        await setPaused(true, badKp);
        t9Results.push({ ok: false, err: "EXPECTED FAILURE but non-admin paused" });
        await setPaused(false).catch(() => {});
      } catch (e: any) {
        const m = (e?.message || "").toLowerCase();
        const ok = m.includes("adminonly") || m.includes("admin") || m.includes("constraint");
        t9Results.push({ ok, err: ok ? "AdminOnly (expected)" : "wrong error: " + (e?.message || "").slice(0, 80) });
      }
      printRow("T9c non-admin → reject", t9Results[t9Results.length - 1]);
    }
    // safety: leave unpaused
    await setPaused(false).catch(() => {});
  }

  // ── Summary ─────────────────────────────────────────────────────────
  const sum = (rs: Result[]) => {
    const ok = rs.filter((r) => r.ok).length;
    const total = rs.length;
    const avgMs = rs.filter((r) => r.ok && r.ms).reduce((a, r) => a + r.ms!, 0) / Math.max(ok, 1);
    return `${ok}/${total} ok  avg ${avgMs.toFixed(0)}ms`;
  };
  console.log("\n═══════════════════════════════════");
  console.log("v1.3 STRESS TEST RESULTS");
  console.log("═══════════════════════════════════");
  console.log(`T4 (multi-mint happy):  ${sum(t4Results)}`);
  if (!SKIP_T5) console.log(`T5 (negative tests):    ${sum(t5Results)}`);
  if (!SKIP_T6) console.log(`T6 (affiliate flow):    ${sum(t6Results)}`);
  if (!SKIP_T7) console.log(`T7 (cross-game):        ${sum(t7Results)}`);
  if (!SKIP_T8) console.log(`T8 (P0-2 payment gate): ${sum(t8Results)}`);
  if (!SKIP_T9) console.log(`T9 (payments killswitch):${sum(t9Results)}`);

  const allOk =
    t4Results.every((r) => r.ok) &&
    (SKIP_T5 || t5Results.every((r) => r.ok)) &&
    (SKIP_T6 || t6Results.every((r) => r.ok)) &&
    (SKIP_T7 || t7Results.every((r) => r.ok)) &&
    (SKIP_T8 || t8Results.every((r) => r.ok)) &&
    (SKIP_T9 || t9Results.every((r) => r.ok));
  console.log(allOk
    ? "\n✅ v1.3 GATE PASSED — multi-token + affiliate + cross-game + negative defenses verified"
    : "\n❌ v1.3 GATE FAILED — fix errors above before mainnet");
  process.exit(allOk ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
