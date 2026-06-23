#!/usr/bin/env tsx
/**
 * Gamerplex Arcade — ProfileExtV2 + HandleClaim smoke test
 *
 * Runs against devnet by default. Creates a fresh ephemeral wallet, airdrops
 * SOL for rent, then exercises set_handle + update_bio happy paths and the
 * key error paths.
 *
 * Usage:
 *   cd gamerplex-arcade/scripts
 *   npm install
 *   npx tsx smoke-profile-ext.ts
 *
 *   # or with an existing keypair (skips airdrop):
 *   KEYPAIR_PATH=~/.config/solana/id.json npx tsx smoke-profile-ext.ts
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { AnchorProvider, Program, Idl, Wallet } from "@coral-xyz/anchor";
import * as fs from "fs";
import * as path from "path";

const NETWORK = (process.env.SOLANA_NETWORK as "mainnet" | "devnet") || "devnet";
const RPC =
  process.env.SOLANA_RPC ||
  (NETWORK === "mainnet"
    ? "https://api.mainnet-beta.solana.com"
    : "https://api.devnet.solana.com");
const KEYPAIR_PATH = process.env.KEYPAIR_PATH;

const ARCADE_PROGRAM_ID = new PublicKey(
  "4FVwdxxBp6PTax2tAcPyHE9rYt8tyNf2YBGrSnSqmx8t"
);

function profileExtPda(wallet: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("profile-ext"), wallet.toBuffer()],
    ARCADE_PROGRAM_ID
  );
}
function handleClaimPda(handle: string): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("handle-claim"), Buffer.from(handle, "utf8")],
    ARCADE_PROGRAM_ID
  );
}

function loadKeypair(p: string): Keypair {
  const raw = JSON.parse(fs.readFileSync(p, "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

function loadIdl(): Idl {
  const idlPath = path.join(
    __dirname,
    "..",
    "target",
    "idl",
    "gamerplex_arcade.json"
  );
  return JSON.parse(fs.readFileSync(idlPath, "utf8"));
}

async function airdrop(conn: Connection, to: PublicKey, sol: number) {
  const sig = await conn.requestAirdrop(to, sol * LAMPORTS_PER_SOL);
  await conn.confirmTransaction(sig, "confirmed");
}

type ExpectResult = "ok" | { errCode: string } | { errSubstr: string };

async function send(
  conn: Connection,
  signer: Keypair,
  ix: any,
  expect: ExpectResult,
  label: string
): Promise<boolean> {
  const tx = new Transaction().add(ix);
  try {
    const sig = await sendAndConfirmTransaction(conn, tx, [signer], {
      commitment: "confirmed",
      skipPreflight: false,
    });
    if (expect === "ok") {
      console.log(`  ✓ ${label}  sig=${sig.slice(0, 12)}…`);
      return true;
    }
    console.log(`  ✗ ${label}  expected failure but tx succeeded`);
    return false;
  } catch (e: any) {
    if (expect === "ok") {
      console.log(`  ✗ ${label}  expected ok but failed:`);
      console.log(`    ${e.message ?? e}`);
      return false;
    }
    const msg = e.message ?? String(e);
    if ("errCode" in expect && msg.includes(expect.errCode)) {
      console.log(`  ✓ ${label}  (rejected as expected: ${expect.errCode})`);
      return true;
    }
    if ("errSubstr" in expect && msg.includes(expect.errSubstr)) {
      console.log(`  ✓ ${label}  (rejected as expected: "${expect.errSubstr}")`);
      return true;
    }
    console.log(`  ✗ ${label}  failed with unexpected error:`);
    console.log(`    ${msg}`);
    return false;
  }
}

async function main() {
  console.log(`Smoke test → ${NETWORK} via ${RPC}`);
  const conn = new Connection(RPC, "confirmed");

  const player = KEYPAIR_PATH ? loadKeypair(KEYPAIR_PATH) : Keypair.generate();
  console.log(`Player: ${player.publicKey.toBase58()}`);

  const bal = await conn.getBalance(player.publicKey);
  if (bal < 0.05 * LAMPORTS_PER_SOL) {
    if (NETWORK !== "devnet") {
      throw new Error(`Insufficient balance and network is ${NETWORK} (no airdrop).`);
    }
    console.log("Airdropping 0.5 SOL...");
    await airdrop(conn, player.publicKey, 0.5);
  }

  const wallet = new Wallet(player);
  const provider = new AnchorProvider(conn, wallet, {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
  const idl = loadIdl();
  const program = new Program(idl, provider);

  // Use a per-run-unique handle to avoid devnet collisions across reruns.
  const suffix = Math.floor(Math.random() * 1_000_000).toString(36);
  const handleA = `smoke_${suffix}_a`;
  const handleB = `smoke_${suffix}_b`;

  console.log(`Handles for this run: ${handleA} → ${handleB}`);

  const [extPda] = profileExtPda(player.publicKey);
  const [claimAPda] = handleClaimPda(handleA);
  const [claimBPda] = handleClaimPda(handleB);

  let passed = 0;
  let total = 0;
  const run = async (ok: boolean) => {
    total += 1;
    if (ok) passed += 1;
  };

  // ── 1. update_bio first (creates the ext PDA) ─────────────────────────────
  console.log("\n[1] update_bio (creates ProfileExtV2 via init_if_needed)");
  run(
    await send(
      conn,
      player,
      await program.methods
        .updateBio("hello from smoke test")
        .accounts({
          profileExt: extPda,
          player: player.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .instruction(),
      "ok",
      "update_bio creates ext"
    )
  );

  const ext1: any = await program.account.profileExtV2.fetch(extPda);
  console.log(
    `  fetched: handle="${ext1.handle}" bio="${ext1.bio}" version=${ext1.profileVersion}`
  );
  run(
    ext1.handle === "" && ext1.bio === "hello from smoke test" && ext1.profileVersion === 2
      ? true
      : (console.log("  ✗ fetched state mismatch"), false)
  );

  // ── 2. set_handle (first claim — old_handle_claim = null) ─────────────────
  console.log("\n[2] set_handle first claim (old_handle_claim = null)");
  run(
    await send(
      conn,
      player,
      await program.methods
        .setHandle(handleA)
        .accounts({
          profileExt: extPda,
          oldHandleClaim: null,
          newHandleClaim: claimAPda,
          player: player.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .instruction(),
      "ok",
      `set_handle("${handleA}")`
    )
  );

  const ext2: any = await program.account.profileExtV2.fetch(extPda);
  run(ext2.handle === handleA ? true : (console.log(`  ✗ ext.handle=${ext2.handle}`), false));
  const claimA: any = await program.account.handleClaim.fetch(claimAPda);
  run(
    claimA.wallet.equals(player.publicKey)
      ? true
      : (console.log("  ✗ claim wallet mismatch"), false)
  );

  // ── 3. set_handle rename (closes old claim, inits new) ────────────────────
  console.log("\n[3] set_handle rename (closes A, opens B)");
  run(
    await send(
      conn,
      player,
      await program.methods
        .setHandle(handleB)
        .accounts({
          profileExt: extPda,
          oldHandleClaim: claimAPda,
          newHandleClaim: claimBPda,
          player: player.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .instruction(),
      "ok",
      `set_handle("${handleB}")`
    )
  );
  const ext3: any = await program.account.profileExtV2.fetch(extPda);
  run(ext3.handle === handleB ? true : (console.log("  ✗ rename didn't apply"), false));
  const oldClaimInfo = await conn.getAccountInfo(claimAPda);
  run(
    oldClaimInfo === null
      ? true
      : (console.log("  ✗ old claim still exists after rename"), false)
  );

  // ── 4. negative cases ─────────────────────────────────────────────────────
  console.log("\n[4] negative cases");

  // 4a. Reserved handle
  const [adminPda] = handleClaimPda("admin");
  run(
    await send(
      conn,
      player,
      await program.methods
        .setHandle("admin")
        .accounts({
          profileExt: extPda,
          oldHandleClaim: claimBPda,
          newHandleClaim: adminPda,
          player: player.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .instruction(),
      { errSubstr: "HandleReserved" },
      "set_handle('admin') → HandleReserved"
    )
  );

  // 4b. Too short
  const [shortPda] = handleClaimPda("ab");
  run(
    await send(
      conn,
      player,
      await program.methods
        .setHandle("ab")
        .accounts({
          profileExt: extPda,
          oldHandleClaim: claimBPda,
          newHandleClaim: shortPda,
          player: player.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .instruction(),
      { errSubstr: "HandleTooShort" },
      "set_handle('ab') → HandleTooShort"
    )
  );

  // 4c. Capital letter (invalid charset)
  const [capPda] = handleClaimPda("Alice");
  run(
    await send(
      conn,
      player,
      await program.methods
        .setHandle("Alice")
        .accounts({
          profileExt: extPda,
          oldHandleClaim: claimBPda,
          newHandleClaim: capPda,
          player: player.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .instruction(),
      { errSubstr: "HandleInvalidChars" },
      "set_handle('Alice') → HandleInvalidChars"
    )
  );

  // 4d. Bio too long
  run(
    await send(
      conn,
      player,
      await program.methods
        .updateBio("x".repeat(141))
        .accounts({
          profileExt: extPda,
          player: player.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .instruction(),
      { errSubstr: "BioTooLong" },
      "update_bio(141 chars) → BioTooLong"
    )
  );

  console.log(`\n=== Result: ${passed}/${total} passed ===`);
  if (passed !== total) process.exit(1);
}

main().catch((e) => {
  console.error("Smoke test crashed:");
  console.error(e);
  process.exit(1);
});
