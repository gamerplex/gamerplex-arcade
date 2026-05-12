/**
 * Arcade bootstrap: initialize_config + register_game(1, "cyber-snake").
 *
 * Run:
 *   cd gamerplex-arcade
 *   npx ts-node migrations/init-arcade.ts
 *
 * Idempotent-ish: skips actions that are already done (detects existing PDAs).
 */
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, clusterApiUrl } from "@solana/web3.js";
import { readFileSync } from "fs";
import * as path from "path";
import type { GamerplexArcade } from "../target/types/gamerplex_arcade";

const PROGRAM_ID = new PublicKey("4FVwdxxBp6PTax2tAcPyHE9rYt8tyNf2YBGrSnSqmx8t");
const RPC = process.env.SOLANA_RPC || "https://api.devnet.solana.com";

function loadAdminKeypair(): Keypair {
  const p = process.env.HOME + "/.config/solana/id.json";
  const raw = JSON.parse(readFileSync(p, "utf8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

async function main() {
  const admin = loadAdminKeypair();
  console.log("admin:", admin.publicKey.toBase58());

  const conn = new Connection(RPC, "confirmed");
  const wallet = new anchor.Wallet(admin);
  const provider = new anchor.AnchorProvider(conn, wallet, {
    commitment: "confirmed",
  });
  anchor.setProvider(provider);

  const idlPath = path.join(__dirname, "..", "target", "idl", "gamerplex_arcade.json");
  const idl = JSON.parse(readFileSync(idlPath, "utf8"));
  const program = new Program(idl, provider) as Program<GamerplexArcade>;

  // ── Step 1: initialize_config (singleton PDA) ──────────────────────────
  const [configPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    PROGRAM_ID
  );
  console.log("config PDA:", configPda.toBase58());

  const existingConfig = await conn.getAccountInfo(configPda);
  if (!existingConfig) {
    console.log("  → initializing ArcadeConfig…");
    const sig = await program.methods
      .initializeConfig(admin.publicKey) // treasury_wallet = admin for now
      .accounts({
        config: configPda,
        admin: admin.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();
    console.log("  ✓ config initialized:", sig);
  } else {
    console.log("  → config already exists, skipping");
  }

  // ── Step 2: register_game(1, "cyber-snake", "Cyber Snake") ─────────────
  const gameId = 1;
  const [gamePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("game"), Buffer.from([gameId])],
    PROGRAM_ID
  );
  console.log("cyber-snake game PDA:", gamePda.toBase58());

  const existingGame = await conn.getAccountInfo(gamePda);
  if (!existingGame) {
    console.log("  → registering Cyber Snake as game_id=1…");
    const sig = await program.methods
      .registerGame(gameId, "cyber-snake", "Cyber Snake")
      .accounts({
        config: configPda,
        game: gamePda,
        admin: admin.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();
    console.log("  ✓ cyber-snake registered:", sig);
  } else {
    console.log("  → cyber-snake already registered, skipping");
  }

  // ── Summary ────────────────────────────────────────────────────────────
  const config: any = await program.account.arcadeConfig.fetch(configPda);
  const game: any = await program.account.game.fetch(gamePda);
  console.log("\n=== State ===");
  console.log("config.admin         :", config.admin.toBase58());
  console.log("config.treasury      :", config.treasuryWallet.toBase58());
  console.log("config.next_game_id  :", config.nextGameId);
  console.log("config.current_season:", config.currentSeason);
  console.log("cyber-snake slug     :", game.slug);
  console.log("cyber-snake created  :", new Date(Number(game.createdAt) * 1000).toISOString());
  console.log("\n✓ Arcade live on devnet. Program:", PROGRAM_ID.toBase58());
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
