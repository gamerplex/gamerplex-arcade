import { Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction, SYSVAR_INSTRUCTIONS_PUBKEY } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, createAssociatedTokenAccountInstruction, createTransferCheckedInstruction, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { AnchorProvider, Program, type Idl } from "@coral-xyz/anchor";
import BN from "bn.js";
import { readFileSync } from "fs";

const PROGRAM_ID = new PublicKey("4FVwdxxBp6PTax2tAcPyHE9rYt8tyNf2YBGrSnSqmx8t");
const GAME_DEVNET = new PublicKey("8eGnj5jkW6zTGYieGhtejPjLtGmnKfCdk7FamoJ5LLvD");
const SPL_MEMO_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
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
  console.log("GAME rate:", rates.gameMicroUsdPerQuark.toString());
  const discounted = Math.floor((50_000 * 80) / 100);
  const rateScaled = BigInt(rates.gameMicroUsdPerQuark.toString());
  const expected = (BigInt(discounted) * RATE_SCALE) / rateScaled;
  const quarks = (expected * 10_050n) / 10_000n;
  console.log("quarks to send:", quarks.toString(), "($", discounted/1_000_000, " worth)");

  const treasury = (await (program.account as any).arcadeConfig.fetch(pda([Buffer.from("config")]))).treasuryWallet;
  const fromAta = getAssociatedTokenAddressSync(GAME_DEVNET, kp.publicKey);
  const toAta = getAssociatedTokenAddressSync(GAME_DEVNET, treasury);

  const tx = new Transaction();
  if (!(await conn.getAccountInfo(toAta))) tx.add(createAssociatedTokenAccountInstruction(kp.publicKey, toAta, treasury, GAME_DEVNET));
  tx.add(createTransferCheckedInstruction(fromAta, GAME_DEVNET, toAta, kp.publicKey, BigInt(quarks.toString()), 10, [], TOKEN_PROGRAM_ID));
  tx.add(await (program.methods as any).recordPayment(2, new BN(discounted), GAME_DEVNET, new BN(quarks.toString()), Array.from(new Uint8Array(64)), "diag").accounts({
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

  try {
    // Simulate first to get full logs
    const sim = await conn.simulateTransaction(tx, [kp]);
    console.log("\n=== SIMULATION LOGS ===");
    (sim.value.logs || []).forEach((l:string) => console.log("  ", l));
    if (sim.value.err) console.log("\nERR:", JSON.stringify(sim.value.err));
  } catch (e:any) {
    console.log("CAUGHT:", e.message);
  }
})();
