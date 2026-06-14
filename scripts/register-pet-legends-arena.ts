// Registers Pet Legends Arena as game_id=6 in the arcade catalog.
// Per PLA Phase A roadmap — see ENGINEERING/GAMES/PET_LEGENDS_ARENA.md.
//
// Run:
//   cd gamerplex-arcade
//   SOLANA_RPC=https://api.devnet.solana.com npx ts-node scripts/register-pet-legends-arena.ts

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { readFileSync } from "fs";
import * as path from "path";
import type { GamerplexArcade } from "../target/types/gamerplex_arcade";

const PROGRAM_ID = new PublicKey("4FVwdxxBp6PTax2tAcPyHE9rYt8tyNf2YBGrSnSqmx8t");
const RPC = process.env.SOLANA_RPC || "https://api.devnet.solana.com";

const GAME = {
  id: 6,
  slug: "pet-legends", // 11 chars — contract MAX_GAME_SLUG_LEN is 16
  displayName: "Pet Legends Arena",
};

const DEADLINE_OFFSET_SEC = 6 * 24 * 3600;

function loadAdminKeypair(): Keypair {
  const p = process.env.SOLANA_KEYPAIR || `${process.env.HOME}/.config/solana/id.json`;
  const raw = JSON.parse(readFileSync(p, "utf8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

async function main() {
  const admin = loadAdminKeypair();
  console.log("admin:", admin.publicKey.toBase58());

  const conn = new Connection(RPC, "confirmed");
  const wallet = new anchor.Wallet(admin);
  const provider = new anchor.AnchorProvider(conn, wallet, { commitment: "confirmed" });
  anchor.setProvider(provider);

  const idlPath = path.join(__dirname, "..", "target", "idl", "gamerplex_arcade.json");
  const idl = JSON.parse(readFileSync(idlPath, "utf8"));
  const program = new Program(idl, provider) as Program<GamerplexArcade>;

  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], PROGRAM_ID);
  console.log("config PDA:", configPda.toBase58());
  const cfg: any = await program.account.arcadeConfig.fetch(configPda);
  console.log("config.admin       :", cfg.admin.toBase58());
  console.log("config.next_game_id:", cfg.nextGameId);

  if (!cfg.admin.equals(admin.publicKey)) {
    throw new Error(
      `Admin mismatch: config.admin=${cfg.admin.toBase58()} but loaded keypair=${admin.publicKey.toBase58()}.\n` +
      `Use the admin keypair (SOLANA_KEYPAIR=... env override available).`,
    );
  }

  const [gamePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("game"), Buffer.from([GAME.id])],
    PROGRAM_ID,
  );
  const existing = await conn.getAccountInfo(gamePda);
  if (existing) {
    console.log(`→ game_id=${GAME.id} (${GAME.slug}) already registered, nothing to do  pda=${gamePda.toBase58()}`);
    return;
  }

  if (cfg.nextGameId !== GAME.id) {
    throw new Error(
      `Game ID mismatch: contract expects next_game_id=${cfg.nextGameId} but this script targets game_id=${GAME.id}.\n` +
      `Register the prior game(s) first, or update this script's GAME.id.`,
    );
  }

  const deadline = Math.floor(Date.now() / 1000) + DEADLINE_OFFSET_SEC;
  console.log(`→ registering game_id=${GAME.id} slug=${GAME.slug} name="${GAME.displayName}" deadline=${deadline}`);

  const sig = await program.methods
    .registerGame(GAME.id, GAME.slug, GAME.displayName, new anchor.BN(deadline))
    .accountsPartial({
      config: configPda,
      game: gamePda,
      admin: admin.publicKey,
      systemProgram: anchor.web3.SystemProgram.programId,
    })
    .signers([admin])
    .rpc();
  console.log(`✓ registered game_id=${GAME.id} sig=${sig}  pda=${gamePda.toBase58()}`);

  // Final state
  const cfgFinal: any = await program.account.arcadeConfig.fetch(configPda);
  console.log(`\nconfig.next_game_id = ${cfgFinal.nextGameId} (next game registration target)`);
  const acct: any = await program.account.game.fetch(gamePda);
  console.log(`game_id=${GAME.id}: slug=${acct.slug} display_name=${acct.displayName}`);
  console.log(`explorer: https://explorer.solana.com/tx/${sig}?cluster=devnet`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
