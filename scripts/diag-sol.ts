import { Connection, Keypair, PublicKey, SystemProgram, Transaction, SYSVAR_INSTRUCTIONS_PUBKEY } from "@solana/web3.js";
import { AnchorProvider, Program, type Idl } from "@coral-xyz/anchor";
import BN from "bn.js";
import { readFileSync } from "fs";

const PROGRAM_ID = new PublicKey("4FVwdxxBp6PTax2tAcPyHE9rYt8tyNf2YBGrSnSqmx8t");
const SPL_MEMO_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const pda = (s: Buffer[]) => PublicKey.findProgramAddressSync(s, PROGRAM_ID)[0];
const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(process.env.HOME + "/.config/solana/id.json", "utf8"))));
const conn = new Connection("https://api.devnet.solana.com", "confirmed");
const w = { publicKey: kp.publicKey, signTransaction: async (t:any)=>{t.partialSign(kp);return t;}, signAllTransactions: async (ts:any[])=>{ts.forEach((t:any)=>t.partialSign(kp));return ts;} };
const provider = new AnchorProvider(conn, w as any, { commitment: "confirmed" });
const idl = JSON.parse(readFileSync("../target/idl/gamerplex_arcade.json", "utf8")) as Idl;
const program = new Program(idl, provider);

(async () => {
  const cfg: any = await (program.account as any).arcadeConfig.fetch(pda([Buffer.from("config")]));
  const treasury = cfg.treasuryWallet as PublicKey;
  console.log("treasury:", treasury.toBase58());
  console.log("player:  ", kp.publicKey.toBase58());
  console.log("same?    ", treasury.equals(kp.publicKey));
  const rates: any = await (program.account as any).exchangeRatesConfig.fetch(pda([Buffer.from("rates")]));
  const solRate = BigInt(rates.solMicroUsdPerLamport.toString());
  const lamports = (50_000n * 1_000_000_000_000n / solRate * 10_050n) / 10_000n;
  console.log("lamports:", lamports.toString());

  const tx = new Transaction();
  tx.add(SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: treasury, lamports: Number(lamports) }));
  tx.add(await (program.methods as any).recordPayment(2, new BN(50_000), PublicKey.default, new BN(lamports.toString()), Array.from(new Uint8Array(64)), "diag-sol").accounts({
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
  console.log("\n=== SIM LOGS ===");
  (sim.value.logs || []).forEach((l:string) => console.log("  ", l));
  if (sim.value.err) console.log("\nERR:", JSON.stringify(sim.value.err));
})();
