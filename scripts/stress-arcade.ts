#!/usr/bin/env tsx
/**
 * ⚠️ DEPRECATED (2026-06-20) — DO NOT RUN. Uses the v1.2 `record_payment` ABI
 * (old 5-arg `(category, amount, sig, bool, externalRef)` + pre-v1.4 account
 * lists) and WILL FAIL against the current IDL. Its T1–T3 happy-path throughput
 * coverage is superseded by:
 *   • `tests/localnet/run.sh`  — free exhaustive coverage (35 tests, $0), and
 *   • `scripts/stress-arcade-v1_3.ts` — current devnet stress (v1.4 ABI).
 * Kept only for historical reference.
 *
 * Gamerplex Arcade — devnet stress test (A.8 of the Mainnet Readiness Gate)
 *
 * Runs:
 *   T1: 100 score commits  ($0.05 each = $5.00 total)
 *   T2: 50 replay commits  ($0.15 each = $7.50 total)
 *   T3: 20 receipt mints   ($0.25 + ~$0.33 rent each = ~$11.60 total)
 *
 * Requires:
 *   - Funded devnet wallet (KEYPAIR_PATH env or ~/.config/solana/id.json)
 *   - Devnet USDC from https://faucet.circle.com or airdrop script
 *   - Total: ~$24.10 USDC + ~8.6 SOL for receipt rents + gas
 *
 * Usage:
 *   cd gamerplex-arcade/scripts
 *   npm install
 *   npm run stress
 *   # or target mainnet for the real gate:
 *   SOLANA_NETWORK=mainnet npm run stress
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SystemProgram,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  createTransferCheckedInstruction,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { AnchorProvider, BN, Program, Idl } from "@coral-xyz/anchor";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import bs58 from "bs58";

// ── Config ────────────────────────────────────────────────────────────────────
const NETWORK = (process.env.SOLANA_NETWORK as "mainnet" | "devnet") || "devnet";
const RPC =
  process.env.SOLANA_RPC ||
  (NETWORK === "mainnet"
    ? "https://api.mainnet-beta.solana.com"
    : "https://api.devnet.solana.com");
const KEYPAIR_PATH =
  process.env.KEYPAIR_PATH ||
  path.join(process.env.HOME || "~", ".config", "solana", "id.json");

const T1_COUNT = parseInt(process.env.T1 || "100");
const T2_COUNT = parseInt(process.env.T2 || "50");
const T3_COUNT = parseInt(process.env.T3 || "20");
const BATCH_DELAY_MS = parseInt(process.env.BATCH_DELAY || "800"); // ms between txs

// ── Constants ─────────────────────────────────────────────────────────────────
const ARCADE_PROGRAM_ID = new PublicKey("4FVwdxxBp6PTax2tAcPyHE9rYt8tyNf2YBGrSnSqmx8t");
const SPL_MEMO_ID       = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const USDC_MAINNET      = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const USDC_DEVNET       = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const USDC_MINT         = NETWORK === "mainnet" ? USDC_MAINNET : USDC_DEVNET;

// Category codes matching the on-chain constants.
const CATEGORY_SCORE_COMMIT    = 2;
const CATEGORY_VERIFIED_COMMIT = 4;
const CATEGORY_REPLAY_RECEIPT  = 5;

const SCORE_COMMIT_MICRO_USD    = 50_000;
const VERIFIED_COMMIT_MICRO_USD = 150_000;
const REPLAY_RECEIPT_MICRO_USD  = 250_000;

const CYBER_SNAKE_GAME_ID = 1;

// ── Helpers ───────────────────────────────────────────────────────────────────
function configPda() {
  return PublicKey.findProgramAddressSync([Buffer.from("config")], ARCADE_PROGRAM_ID);
}
function stablecoinConfigPda() {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("stablecoins")],
    ARCADE_PROGRAM_ID
  );
}
function gamePda(gameId: number) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("game"), Buffer.from([gameId])],
    ARCADE_PROGRAM_ID
  );
}
function profilePda(wallet: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("profile"), wallet.toBuffer()],
    ARCADE_PROGRAM_ID
  );
}
function profileExtPda(wallet: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("profile-ext"), wallet.toBuffer()],
    ARCADE_PROGRAM_ID
  );
}
function handleClaimPda(handle: string) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("handle-claim"), Buffer.from(handle, "utf8")],
    ARCADE_PROGRAM_ID
  );
}
function receiptPda(player: PublicKey, nonce: BN) {
  const nonceLe = nonce.toArrayLike(Buffer, "le", 8);
  return PublicKey.findProgramAddressSync(
    [Buffer.from("receipt"), player.toBuffer(), nonceLe],
    ARCADE_PROGRAM_ID
  );
}

function randomSeed(): Uint8Array {
  return new Uint8Array(crypto.randomBytes(32));
}
function sha256(data: Uint8Array): Uint8Array {
  return new Uint8Array(crypto.createHash("sha256").update(data).digest());
}

// ── Node-side wallet adapter shim ─────────────────────────────────────────────
function makeNodeWallet(kp: Keypair) {
  return {
    publicKey: kp.publicKey,
    signTransaction: async (tx: any) => { tx.partialSign(kp); return tx; },
    signAllTransactions: async (txs: any[]) => { txs.forEach(tx => tx.partialSign(kp)); return txs; },
  };
}

// ── Result tracker ────────────────────────────────────────────────────────────
type Result = { ok: boolean; sig?: string; ms?: number; err?: string };

function printRow(label: string, r: Result) {
  const status = r.ok ? "✅" : "❌";
  const timing = r.ok && r.ms !== undefined ? `${r.ms}ms` : "";
  const info   = r.ok ? r.sig?.slice(0, 20) + "…" : r.err?.slice(0, 60);
  console.log(`  ${status} ${label.padEnd(20)} ${timing.padEnd(8)} ${info}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n=== Gamerplex Arcade Stress Test (${NETWORK}) ===`);
  console.log(`  T1: ${T1_COUNT} × $0.05  T2: ${T2_COUNT} × $0.15  T3: ${T3_COUNT} × ($0.25 + rent)`);
  console.log(`  RPC: ${RPC}\n`);

  // Load keypair
  if (!fs.existsSync(KEYPAIR_PATH)) {
    console.error(`Keypair not found: ${KEYPAIR_PATH}`);
    console.error("Set KEYPAIR_PATH= or fund ~/.config/solana/id.json");
    process.exit(1);
  }
  const kpBytes = JSON.parse(fs.readFileSync(KEYPAIR_PATH, "utf8"));
  const kp = Keypair.fromSecretKey(new Uint8Array(kpBytes));
  console.log(`Wallet: ${kp.publicKey.toBase58()}`);

  const connection = new Connection(RPC, "confirmed");
  const wallet     = makeNodeWallet(kp);
  const provider   = new AnchorProvider(connection, wallet as any, { commitment: "confirmed" });

  // Load IDL from the built artifact
  const idlPath = path.join(__dirname, "../target/idl/gamerplex_arcade.json");
  if (!fs.existsSync(idlPath)) {
    console.error(`IDL not found at ${idlPath}`);
    console.error("Run: anchor build");
    process.exit(1);
  }
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf8")) as Idl;
  const program = new Program(idl, provider);

  // ── Balance check ──────────────────────────────────────────────────────────
  const solBalance  = await connection.getBalance(kp.publicKey);
  const treasuryPk  = await getTreasury(program);
  const fromAta     = getAssociatedTokenAddressSync(USDC_MINT, kp.publicKey);
  let usdcBalance   = 0;
  try {
    const tokenBal = await connection.getTokenAccountBalance(fromAta);
    usdcBalance = tokenBal.value.uiAmount ?? 0;
  } catch {
    console.error("\nNo USDC token account found. Fund it first:");
    console.error("  https://faucet.circle.com  (devnet USDC)");
    process.exit(1);
  }

  const requiredUsdc =
    (T1_COUNT * SCORE_COMMIT_MICRO_USD +
     T2_COUNT * VERIFIED_COMMIT_MICRO_USD +
     T3_COUNT * REPLAY_RECEIPT_MICRO_USD) / 1_000_000;
  const requiredSolRent = T3_COUNT * 0.002; // ~0.002 SOL rent per receipt PDA

  console.log(`SOL balance:  ${(solBalance / 1e9).toFixed(4)} SOL`);
  console.log(`USDC balance: ${usdcBalance.toFixed(2)} USDC`);
  console.log(`Required:     ${requiredUsdc.toFixed(2)} USDC + ~${requiredSolRent.toFixed(3)} SOL rent`);

  if (usdcBalance < requiredUsdc) {
    console.error(`\n❌ Insufficient USDC. Need ${requiredUsdc.toFixed(2)}, have ${usdcBalance.toFixed(2)}`);
    process.exit(1);
  }
  if (solBalance / 1e9 < requiredSolRent + 0.1) {
    console.error(`\n❌ Insufficient SOL. Need ~${(requiredSolRent + 0.1).toFixed(3)}, have ${(solBalance / 1e9).toFixed(4)}`);
    process.exit(1);
  }
  console.log("Balances OK ✅\n");

  // ── Bootstrap: StablecoinConfig PDA (one-time, v1.2) ───────────────────────
  const [stablecoinCfgAddr] = stablecoinConfigPda();
  const scInfo = await connection.getAccountInfo(stablecoinCfgAddr);
  if (!scInfo) {
    console.log("Bootstrapping StablecoinConfig (v1.2)…");
    const [cfg0] = configPda();
    const mints: PublicKey[] = [];
    for (let i = 0; i < 8; i++) mints.push(i === 0 ? USDC_MINT : PublicKey.default);
    const ix = await (program.methods as any)
      .initializeStablecoins(mints)
      .accounts({
        config: cfg0,
        stablecoinConfig: stablecoinCfgAddr,
        admin: kp.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
    const sig = await sendAndConfirmTransaction(connection, new Transaction().add(ix), [kp]);
    console.log(`Stablecoins initialised: ${sig.slice(0, 20)}… (USDC only)\n`);
  } else {
    console.log("StablecoinConfig exists ✅\n");
  }

  // ── Ensure profile exists ──────────────────────────────────────────────────
  const [profileAddr] = profilePda(kp.publicKey);
  const profileInfo   = await connection.getAccountInfo(profileAddr);
  if (!profileInfo) {
    console.log("Opening PlayerProfile…");
    const [cfg] = configPda();
    const ix = await (program.methods as any)
      .openPlayerProfile(PublicKey.default)
      .accounts({
        config: cfg,
        profile: profileAddr,
        referrerProfile: null,
        player: kp.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
    const sig = await sendAndConfirmTransaction(connection, new Transaction().add(ix), [kp]);
    console.log(`Profile opened: ${sig.slice(0, 20)}…\n`);
  } else {
    console.log("PlayerProfile exists ✅\n");
  }

  // ── Shared treasury ATA (ensure exists) ────────────────────────────────────
  const toAta = getAssociatedTokenAddressSync(USDC_MINT, treasuryPk);
  const toAtaInfo = await connection.getAccountInfo(toAta);

  // ── Stats ──────────────────────────────────────────────────────────────────
  const results: { t1: Result[]; t2: Result[]; t3: Result[] } = { t1: [], t2: [], t3: [] };

  // ── T1: score commits ──────────────────────────────────────────────────────
  console.log(`── T1: ${T1_COUNT} score commits ──`);
  const [gamePdaAddr] = gamePda(CYBER_SNAKE_GAME_ID);
  const [cfgAddr]     = configPda();

  for (let i = 0; i < T1_COUNT; i++) {
    const t0    = Date.now();
    const seed  = randomSeed();
    const score = new BN(Math.floor(Math.random() * 9000) + 1000);
    const moveHash = sha256(new Uint8Array(0));
    const fakeSig  = new Uint8Array(64); // stress test — no real prior payment sig needed

    try {
      const tx = new Transaction();

      // USDC transfer
      if (!toAtaInfo && i === 0) {
        tx.add(createAssociatedTokenAccountInstruction(kp.publicKey, toAta, treasuryPk, USDC_MINT));
      }
      tx.add(createTransferCheckedInstruction(
        fromAta, USDC_MINT, toAta, kp.publicKey,
        BigInt(SCORE_COMMIT_MICRO_USD), 6, [], TOKEN_PROGRAM_ID
      ));

      // record_payment (v1.2: requires config + stablecoin_config + instructions_sysvar)
      tx.add(await (program.methods as any)
        .recordPayment(CATEGORY_SCORE_COMMIT, new BN(SCORE_COMMIT_MICRO_USD), Array.from(fakeSig), false, "")
        .accounts({
          config: cfgAddr,
          stablecoinConfig: stablecoinCfgAddr,
          game: gamePdaAddr,
          profile: profileAddr,
          wallet: kp.publicKey,
          referrerProfile: null,
          player: kp.publicKey,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .instruction());

      // submit_score
      tx.add(await (program.methods as any)
        .submitScore("solo", score, 0, 0, Array.from(seed), 60, Array.from(moveHash), "", PublicKey.default)
        .accounts({ config: cfgAddr, game: gamePdaAddr, profile: profileAddr, wallet: kp.publicKey, player: kp.publicKey, memoProgram: SPL_MEMO_ID })
        .instruction());

      const sig = await sendAndConfirmTransaction(connection, tx, [kp]);
      results.t1.push({ ok: true, sig, ms: Date.now() - t0 });
      if ((i + 1) % 10 === 0 || i === 0) printRow(`T1[${i + 1}/${T1_COUNT}]`, results.t1[i]);
    } catch (e: any) {
      results.t1.push({ ok: false, err: e.message });
      printRow(`T1[${i + 1}/${T1_COUNT}]`, results.t1[i]);
    }
    if (i < T1_COUNT - 1) await sleep(BATCH_DELAY_MS);
  }

  // ── T2: replay commits ─────────────────────────────────────────────────────
  console.log(`\n── T2: ${T2_COUNT} replay commits ──`);
  for (let i = 0; i < T2_COUNT; i++) {
    const t0   = Date.now();
    const seed = randomSeed();
    const moveLog = new Uint8Array(9); // 3 direction changes (3 bytes each)
    const fakeSig = new Uint8Array(64);

    try {
      const tx = new Transaction();
      tx.add(createTransferCheckedInstruction(
        fromAta, USDC_MINT, toAta, kp.publicKey,
        BigInt(VERIFIED_COMMIT_MICRO_USD), 6, [], TOKEN_PROGRAM_ID
      ));
      tx.add(await (program.methods as any)
        .recordPayment(CATEGORY_VERIFIED_COMMIT, new BN(VERIFIED_COMMIT_MICRO_USD), Array.from(fakeSig), false, "")
        .accounts({
          config: cfgAddr,
          stablecoinConfig: stablecoinCfgAddr,
          game: gamePdaAddr,
          profile: profileAddr,
          wallet: kp.publicKey,
          referrerProfile: null,
          player: kp.publicKey,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .instruction());
      tx.add(await (program.methods as any)
        .commitSessionReplay(new BN(i), Array.from(seed), Buffer.from(moveLog))
        .accounts({
          player: kp.publicKey,
          memoProgram: SPL_MEMO_ID,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .instruction());

      const sig = await sendAndConfirmTransaction(connection, tx, [kp]);
      results.t2.push({ ok: true, sig, ms: Date.now() - t0 });
      if ((i + 1) % 10 === 0 || i === 0) printRow(`T2[${i + 1}/${T2_COUNT}]`, results.t2[i]);
    } catch (e: any) {
      results.t2.push({ ok: false, err: e.message });
      printRow(`T2[${i + 1}/${T2_COUNT}]`, results.t2[i]);
    }
    if (i < T2_COUNT - 1) await sleep(BATCH_DELAY_MS);
  }

  // ── T3: receipt mints ──────────────────────────────────────────────────────
  console.log(`\n── T3: ${T3_COUNT} receipt mints ──`);
  const t3StartNonce = Date.now(); // Use timestamp-based nonces to guarantee uniqueness
  for (let i = 0; i < T3_COUNT; i++) {
    const t0       = Date.now();
    const nonce    = new BN(t3StartNonce + i);
    const seed     = randomSeed();
    const moveHash = sha256(new Uint8Array(0));
    const [rcptAddr] = receiptPda(kp.publicKey, nonce);
    const score = new BN(Math.floor(Math.random() * 5000) + 500);
    const gpx5rSig = new Uint8Array(64); // the T2 tx sig that produced the replay
    const fakeSig  = new Uint8Array(64);

    try {
      const tx = new Transaction();
      tx.add(createTransferCheckedInstruction(
        fromAta, USDC_MINT, toAta, kp.publicKey,
        BigInt(REPLAY_RECEIPT_MICRO_USD), 6, [], TOKEN_PROGRAM_ID
      ));
      tx.add(await (program.methods as any)
        .recordPayment(CATEGORY_REPLAY_RECEIPT, new BN(REPLAY_RECEIPT_MICRO_USD), Array.from(fakeSig), false, "")
        .accounts({
          config: cfgAddr,
          stablecoinConfig: stablecoinCfgAddr,
          game: gamePdaAddr,
          profile: profileAddr,
          wallet: kp.publicKey,
          referrerProfile: null,
          player: kp.publicKey,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .instruction());
      tx.add(await (program.methods as any)
        .mintReplayReceipt(nonce, score, 0, 0, Array.from(seed), Array.from(moveHash), 60, Array.from(gpx5rSig))
        .accounts({
          config: cfgAddr,
          game: gamePdaAddr,
          receipt: rcptAddr,
          player: kp.publicKey,
          systemProgram: SystemProgram.programId,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .instruction());

      const sig = await sendAndConfirmTransaction(connection, tx, [kp]);
      results.t3.push({ ok: true, sig, ms: Date.now() - t0 });
      if ((i + 1) % 5 === 0 || i === 0) printRow(`T3[${i + 1}/${T3_COUNT}]`, results.t3[i]);
    } catch (e: any) {
      results.t3.push({ ok: false, err: e.message });
      printRow(`T3[${i + 1}/${T3_COUNT}]`, results.t3[i]);
    }
    if (i < T3_COUNT - 1) await sleep(BATCH_DELAY_MS);
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  const summary = (rs: Result[]) => {
    const ok    = rs.filter(r => r.ok).length;
    const total = rs.length;
    const avgMs = rs.filter(r => r.ok && r.ms).reduce((a, r) => a + r.ms!, 0) / Math.max(ok, 1);
    return `${ok}/${total} ok  avg ${avgMs.toFixed(0)}ms`;
  };

  console.log("\n═══════════════════════════════════");
  console.log("STRESS TEST RESULTS");
  console.log("═══════════════════════════════════");
  console.log(`T1 (save score):   ${summary(results.t1)}`);
  console.log(`T2 (save replay):  ${summary(results.t2)}`);
  console.log(`T3 (mint receipt): ${summary(results.t3)}`);

  const allOk =
    results.t1.every(r => r.ok) &&
    results.t2.every(r => r.ok) &&
    results.t3.every(r => r.ok);
  console.log(allOk ? "\n✅ GATE A.8 PASSED — ready for mainnet" : "\n❌ GATE A.8 FAILED — fix errors above");
  process.exit(allOk ? 0 : 1);
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function getTreasury(program: Program): Promise<PublicKey> {
  const [cfg] = PublicKey.findProgramAddressSync([Buffer.from("config")], ARCADE_PROGRAM_ID);
  const config: any = await (program.account as any).arcadeConfig.fetch(cfg);
  return config.treasuryWallet as PublicKey;
}

main().catch(err => { console.error(err); process.exit(1); });
