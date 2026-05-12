// Registers game_ids 2-4 on the arcade registry. Run after deploy.
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { readFileSync } from "fs";
import * as path from "path";
import type { GamerplexArcade } from "../target/types/gamerplex_arcade";

const PROGRAM_ID = new PublicKey("4FVwdxxBp6PTax2tAcPyHE9rYt8tyNf2YBGrSnSqmx8t");
const RPC = process.env.SOLANA_RPC || "https://api.devnet.solana.com";

const GAMES: { id: number; slug: string; displayName: string }[] = [
  { id: 2, slug: "reserved", displayName: "Reserved" },
  { id: 3, slug: "chess-puzzles", displayName: "Magic Chess Puzzles" },
  { id: 4, slug: "blockwords", displayName: "Blockwords" },
];

const DEADLINE_OFFSET_SEC = 6 * 24 * 3600;

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
      `Replace ~/.config/solana/id.json with the keypair that matches config.admin, or run from that machine.`
    );
  }

  for (const g of GAMES) {
    const [gamePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("game"), Buffer.from([g.id])],
      PROGRAM_ID
    );
    const existing = await conn.getAccountInfo(gamePda);
    if (existing) {
      console.log(`  → game_id=${g.id} (${g.slug}) already registered, skipping  pda=${gamePda.toBase58()}`);
      continue;
    }

    const deadline = Math.floor(Date.now() / 1000) + DEADLINE_OFFSET_SEC;
    console.log(`  → registering game_id=${g.id} slug=${g.slug} name="${g.displayName}" deadline=${deadline}`);
    try {
      const sig = await program.methods
        .registerGame(g.id, g.slug, g.displayName, new anchor.BN(deadline))
        .accounts({
          config: configPda,
          game: gamePda,
          admin: admin.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([admin])
        .rpc();
      console.log(`    ✓ registered game_id=${g.id} sig=${sig}  pda=${gamePda.toBase58()}`);
    } catch (e: any) {
      const msg = e?.message || String(e);
      console.error(`    ✗ failed game_id=${g.id}: ${msg}`);
      throw e;
    }
  }

  console.log("\n=== Final state ===");
  const cfgFinal: any = await program.account.arcadeConfig.fetch(configPda);
  console.log(`  config.next_game_id = ${cfgFinal.nextGameId}`);
  for (const g of GAMES) {
    const [gp] = PublicKey.findProgramAddressSync(
      [Buffer.from("game"), Buffer.from([g.id])],
      PROGRAM_ID
    );
    try {
      const acct: any = await program.account.game.fetch(gp);
      console.log(`  game_id=${g.id} slug=${acct.slug} display_name=${acct.displayName} pda=${gp.toBase58()}`);
    } catch {
      console.log(`  game_id=${g.id} not registered`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
