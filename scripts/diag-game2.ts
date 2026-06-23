import { Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction, SYSVAR_INSTRUCTIONS_PUBKEY } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, createTransferCheckedInstruction, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { AnchorProvider, Program, type Idl } from "@coral-xyz/anchor";
import BN from "bn.js";
import { readFileSync } from "fs";

const PROGRAM_ID = new PublicKey("4FVwdxxBp6PTax2tAcPyHE9rYt8tyNf2YBGrSnSqmx8t");
const GAME_DEVNET = new PublicKey("8eGnj5jkW6zTGYieGhtejPjLtGmnKfCdk7FamoJ5LLvD");
const RATE_SCALE = 1_000_000_000_000n;
const pda = (s: Buffer[]) => PublicKey.findProgramAddressSync(s, PROGRAM_ID)[0];
const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(process.env.HOME + "/.config/solana/id.json", "utf8"))));
const conn = new Connection("https://api.devnet.solana.com", "confirmed");
const w = { publicKey: kp.publicKey, signTransaction: async (t:any)=>{t.partialSign(kp);return t;}, signAllTransactions: async (ts:any[])=>{ts.forEach((t:any)=>t.partialSign(kp));return ts;} };
const provider = new AnchorProvider(conn, w as any, { commitment: "confirmed" });
const idl = JSON.parse(readFileSync("../target/idl/gamerplex_arcade.json", "utf8")) as Idl;
const program = new Program(idl, provider);

(async () => {
  const rates: any = await (program.account as any).exchangeRatesConfig.fetch(pda([Buffer.from("rates")]));
  const cfg: any = await (program.account as any).arcadeConfig.fetch(pda([Buffer.from("config")]));
  const treasury = cfg.treasuryWallet;
  const rateScaled = BigInt(rates.gameMicroUsdPerQuark.toString());
  // 80% discount: declare $0.05 but send only enough quarks for $0.04 of GAME
  const discountedUsd = 40_000n;
  const expected = (discountedUsd * RATE_SCALE) / rateScaled;
  const quarks = (expected * 10_050n) / 10_000n;
  console.log("rate scaled:", rateScaled.toString());
  console.log("quarks (80%):", quarks.toString());

  const fromAta = getAssociatedTokenAddressSync(GAME_DEVNET, kp.publicKey);
  const toAta = getAssociatedTokenAddressSync(GAME_DEVNET, treasury);
  const tx = new Transaction();
  tx.add(createTransferCheckedInstruction(fromAta, GAME_DEVNET, toAta, kp.publicKey, BigInt(quarks.toString()), 10, [], TOKEN_PROGRAM_ID));
  tx.add(await (program.methods as any).recordPayment(2, new BN(50_000), GAME_DEVNET, new BN(quarks.toString()), Array.from(new Uint8Array(64)), "diag-g2").accounts({
    config: pda([Buffer.from("config")]),
    stablecoinConfig: pda([Buffer.from("stablecoins")]),
    game: pda([Buffer.from("game"), Buffer.from([5])]),
    profile: pda([Buffer.from("profile"), kp.publicKey.toBuffer()]),
    wallet: kp.publicKey,
    referrerProfile: null,
    rates: pda([Buffer.from("rates")]),
    affiliateConfig: pda([Buffer.from("affiliate")]),
    player: kp.publicKey,
    instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
  }).instruction());

  const sim = await conn.simulateTransaction(tx, [kp]);
  console.log("\n=== SIM ===");
  (sim.value.logs || []).filter(l => l.includes("Program log") || l.includes("AnchorError") || l.includes("error")).forEach(l => console.log("  ", l));
  if (sim.value.err) console.log("ERR:", JSON.stringify(sim.value.err));
})();
