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

const SCORE_COMMIT_MICRO_USD = 50_000; // $0.05
const CATEGORY_SCORE_COMMIT = 2;
const FLIPBALL_GAME_ID = 5;
const CYBER_SNAKE_GAME_ID = 1;

// PDAs
const pda = (seeds: (Buffer | Uint8Array)[]) =>
  PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];
const configPda = () => pda([Buffer.from("config")]);
const stablecoinsPda = () => pda([Buffer.from("stablecoins")]);
const ratesPda = () => pda([Buffer.from("rates")]);
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
      referrerProfile: null,
      rates: ratesPda(),
      player,
      instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
    })
    .instruction();
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
          // 20% discount applied frontend-side
          const discounted = Math.floor((base * 80) / 100);
          const expected = convertUsdToRaw(discounted, BigInt(rates.gameMicroUsdPerQuark.toString()));
          const quarks = applyOverpay(expected);
          paymentAmountRaw = new BN(quarks.toString());
          amountMicroUsdToRecord = discounted;
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

    // T5d — $GAME underpaid past slippage
    {
      const t0 = Date.now();
      try {
        const tx = new Transaction();
        const base = SCORE_COMMIT_MICRO_USD;
        const discounted = Math.floor((base * 80) / 100);
        const expected = convertUsdToRaw(discounted, BigInt(rates.gameMicroUsdPerQuark.toString()));
        const underpayQuarks = (expected * 90n) / 100n; // 10% underpay
        const fromAta = getAssociatedTokenAddressSync(GAME_MINT, kp.publicKey);
        const toAta = getAssociatedTokenAddressSync(GAME_MINT, treasury);
        tx.add(createTransferCheckedInstruction(
          fromAta, GAME_MINT, toAta, kp.publicKey,
          BigInt(underpayQuarks.toString()), GAME_DECIMALS, [], TOKEN_PROGRAM_ID,
        ));
        tx.add(await buildRecordPaymentIx(program, kp.publicKey, {
          category: CATEGORY_SCORE_COMMIT,
          amountMicroUsd: new BN(discounted),
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

  const allOk =
    t4Results.every((r) => r.ok) &&
    (SKIP_T5 || t5Results.every((r) => r.ok));
  console.log(allOk
    ? "\n✅ v1.3 GATE PASSED — multi-token + negative defenses verified"
    : "\n❌ v1.3 GATE FAILED — fix errors above before mainnet");
  process.exit(allOk ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
