/**
 * Gamerplex Arcade — exchange-rate pusher.
 *
 * Polls SOL/USD (Pyth) + $GAME/USD (Flipcash curve state) every PUSH_INTERVAL_SEC.
 * Calls `update_exchange_rates` ix if rate moved >DELTA_BPS_THRESHOLD or
 * MAX_STALE_BEFORE_PUSH_SEC since last on-chain timestamp.
 *
 * Run two instances (NixOS xnode + GCP) for redundancy. Last-write-wins is fine
 * since admin txs are idempotent (just refreshes the timestamp).
 */
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import { AnchorProvider, BN, Program, Wallet } from "@coral-xyz/anchor";
import { parsePriceData } from "@pythnetwork/client";
import { readFileSync } from "fs";
import * as path from "path";
import * as http from "http";

// ── Config ────────────────────────────────────────────────────────────
const NETWORK = (process.env.SOLANA_NETWORK as "mainnet" | "devnet") || "devnet";
const RPC =
  process.env.SOLANA_RPC ||
  (NETWORK === "mainnet" ? "https://api.mainnet-beta.solana.com" : "https://api.devnet.solana.com");
const PROGRAM_ID = new PublicKey(
  process.env.PROGRAM_ID || "4FVwdxxBp6PTax2tAcPyHE9rYt8tyNf2YBGrSnSqmx8t"
);
const KEYPAIR_PATH =
  process.env.KEYPAIR_PATH || (process.env.HOME || "~") + "/.config/solana/id.json";

const PUSH_INTERVAL_SEC = Number(process.env.PUSH_INTERVAL_SEC || 900);
const DELTA_BPS_THRESHOLD = Number(process.env.DELTA_BPS_THRESHOLD || 100); // 1%
const MAX_STALE_BEFORE_PUSH_SEC = Number(process.env.MAX_STALE_BEFORE_PUSH_SEC || 3600);
const HEALTH_PORT = Number(process.env.HEALTH_PORT || 8090);

// Pyth SOL/USD — public price accounts
const PYTH_SOL_USD_MAINNET = new PublicKey("H6ARHf6YXhGYeQfUzQNGk6rDNnLBQKrenN712K4AQJEG");
const PYTH_SOL_USD_DEVNET = new PublicKey("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix");
const PYTH_SOL_USD =
  process.env.PYTH_SOL_PRICE_ACCOUNT
    ? new PublicKey(process.env.PYTH_SOL_PRICE_ACCOUNT)
    : NETWORK === "mainnet"
      ? PYTH_SOL_USD_MAINNET
      : PYTH_SOL_USD_DEVNET;

// Flipcash $GAME pool PDA — derived from currency PDA on first run
const FLIPCASH_PROGRAM = new PublicKey(
  NETWORK === "mainnet"
    ? "ccJYP5gjZqcEHaphcxAZvkxCrnTVfYMjyhSYkpQtf8Z"
    : "FLip3dQVfpeUKg5fUNfFhcHvQvG3HoXqYw5XDDx8Wo9i"
);
const GAME_MINT = new PublicKey(
  NETWORK === "mainnet"
    ? "7TTBUfDomCKBMemv7FF37Tg3y52cRkAxn8vJnvKD4rsE"
    : "8eGnj5jkW6zTGYieGhtejPjLtGmnKfCdk7FamoJ5LLvD"
);
const USDF_MINT = new PublicKey(
  NETWORK === "mainnet"
    ? "5AMAA9JV9H97YYVxx8F6FsCMmTwXSuTTQneiup4RYAUQ"
    : "USDFBnpup7jXV8DZ9jvz3cR4syDYegoSBnarmxMeLgT"
);

const RATE_SCALE_FACTOR = 1_000_000_000_000n; // ×1e12, matches on-chain

const SOL_DECIMALS = 9;
const GAME_DECIMALS = 10;

// ── Helpers ───────────────────────────────────────────────────────────
function configPda(): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("config")], PROGRAM_ID)[0];
}
function ratesPda(): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("rates")], PROGRAM_ID)[0];
}
function flipcashCurrencyPda(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("currency"), mint.toBuffer()],
    FLIPCASH_PROGRAM
  )[0];
}
function flipcashPoolPda(currency: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("pool"), currency.toBuffer()],
    FLIPCASH_PROGRAM
  )[0];
}
function flipcashVaultPda(pool: PublicKey, mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("treasury"), pool.toBuffer(), mint.toBuffer()],
    FLIPCASH_PROGRAM
  )[0];
}

function loadAdmin(): Keypair {
  const raw = JSON.parse(readFileSync(KEYPAIR_PATH, "utf8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

/** Convert "dollars per native token" → scaled micro-USD per smallest unit. */
function quoteToScaled(usdPerToken: number, decimals: number): bigint {
  const microUsdPerToken = usdPerToken * 1_000_000;
  const microUsdPerSmallestUnit = microUsdPerToken / 10 ** decimals;
  return BigInt(Math.floor(microUsdPerSmallestUnit * Number(RATE_SCALE_FACTOR)));
}

// ── Fetch quotes ──────────────────────────────────────────────────────
async function fetchSolUsd(conn: Connection): Promise<number> {
  const acc = await conn.getAccountInfo(PYTH_SOL_USD);
  if (!acc) throw new Error("Pyth SOL/USD account not found");
  const data = parsePriceData(acc.data);
  if (data.price === undefined || data.price === null) {
    throw new Error("Pyth price unavailable");
  }
  return data.price;
}

/** Read Flipcash curve state for $GAME and compute spot USD price.
 *  Curve uses USD-backed exponential bonding (curve constants in
 *  `submodules/flipcash-program/api/src/consts.rs`). For simplicity v1 we
 *  approximate spot via vault ratios; v1.1 will use the exact curve formula. */
async function fetchGameUsd(conn: Connection): Promise<number> {
  const currency = flipcashCurrencyPda(GAME_MINT);
  const pool = flipcashPoolPda(currency);
  const gameVault = flipcashVaultPda(pool, GAME_MINT);
  const usdfVault = flipcashVaultPda(pool, USDF_MINT);

  // Read vault balances (SPL token accounts — amount at offset 64, u64 LE)
  const [gameAcc, usdfAcc] = await Promise.all([
    conn.getAccountInfo(gameVault),
    conn.getAccountInfo(usdfVault),
  ]);
  if (!gameAcc || !usdfAcc) throw new Error("Flipcash vault accounts not found");
  const gameVaultRaw = gameAcc.data.readBigUInt64LE(64);  // GAME quarks (10 decimals)
  const usdfVaultRaw = usdfAcc.data.readBigUInt64LE(64);  // USDF micro (6 decimals)

  // Outstanding GAME supply = MAX_SUPPLY - vault_balance
  // GAME spot ≈ d(usdf_locked) / d(supply) ≈ usdf_locked / supply (linear approx)
  // This is rough — exact curve is exponential. Refine in v1.1.
  const MAX_SUPPLY_QUARKS = 21_000_000n * 10_000_000_000n;
  const outstanding = MAX_SUPPLY_QUARKS - gameVaultRaw;
  if (outstanding === 0n) return 0.01; // curve floor
  const usdfLocked = Number(usdfVaultRaw) / 1_000_000; // USD
  const tokensOutstanding = Number(outstanding) / 10_000_000_000;
  const spot = usdfLocked / tokensOutstanding;
  return Math.max(spot, 0.01); // never below $0.01 floor
}

// ── Push ──────────────────────────────────────────────────────────────
let lastSolScaled = 0n;
let lastGameScaled = 0n;
let lastSolPushAt = 0;
let lastGamePushAt = 0;

async function maybePush(conn: Connection, program: Program, admin: Keypair) {
  const now = Math.floor(Date.now() / 1000);

  let solUsd: number, gameUsd: number;
  try {
    [solUsd, gameUsd] = await Promise.all([fetchSolUsd(conn), fetchGameUsd(conn)]);
  } catch (e) {
    console.error(`[${new Date().toISOString()}] fetch failed:`, (e as Error).message);
    return;
  }

  const solScaled = quoteToScaled(solUsd, SOL_DECIMALS);
  const gameScaled = quoteToScaled(gameUsd, GAME_DECIMALS);

  const solDeltaBps = lastSolScaled === 0n
    ? 10_000n
    : (solScaled > lastSolScaled ? solScaled - lastSolScaled : lastSolScaled - solScaled) * 10_000n / lastSolScaled;
  const gameDeltaBps = lastGameScaled === 0n
    ? 10_000n
    : (gameScaled > lastGameScaled ? gameScaled - lastGameScaled : lastGameScaled - gameScaled) * 10_000n / lastGameScaled;

  const solStale = now - lastSolPushAt > MAX_STALE_BEFORE_PUSH_SEC;
  const gameStale = now - lastGamePushAt > MAX_STALE_BEFORE_PUSH_SEC;

  const pushSol = Number(solDeltaBps) >= DELTA_BPS_THRESHOLD || solStale;
  const pushGame = Number(gameDeltaBps) >= DELTA_BPS_THRESHOLD || gameStale;

  if (!pushSol && !pushGame) {
    console.log(`[${new Date().toISOString()}] no push — SOL Δ=${solDeltaBps}bps GAME Δ=${gameDeltaBps}bps`);
    return;
  }

  const deadline = new BN(now + 1800); // 30-min validity
  try {
    const sig = await (program.methods as any)
      .updateExchangeRates(
        new BN(pushSol ? solScaled.toString() : "0"),
        new BN(pushGame ? gameScaled.toString() : "0"),
        deadline
      )
      .accounts({
        config: configPda(),
        rates: ratesPda(),
        admin: admin.publicKey,
      })
      .rpc();

    if (pushSol) { lastSolScaled = solScaled; lastSolPushAt = now; }
    if (pushGame) { lastGameScaled = gameScaled; lastGamePushAt = now; }
    console.log(`[${new Date().toISOString()}] PUSHED — SOL=$${solUsd.toFixed(4)} GAME=$${gameUsd.toFixed(6)} sig=${sig.slice(0, 20)}…`);
  } catch (e) {
    console.error(`[${new Date().toISOString()}] push failed:`, (e as Error).message);
  }
}

// ── Health endpoint ───────────────────────────────────────────────────
function startHealthServer() {
  http
    .createServer((req, res) => {
      if (req.url === "/healthz") {
        const now = Math.floor(Date.now() / 1000);
        const solAge = now - lastSolPushAt;
        const gameAge = now - lastGamePushAt;
        const healthy = solAge < 2 * MAX_STALE_BEFORE_PUSH_SEC && gameAge < 2 * MAX_STALE_BEFORE_PUSH_SEC;
        res.writeHead(healthy ? 200 : 503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ healthy, solAgeSec: solAge, gameAgeSec: gameAge, network: NETWORK }));
      } else {
        res.writeHead(404).end();
      }
    })
    .listen(HEALTH_PORT, () => console.log(`health: http://0.0.0.0:${HEALTH_PORT}/healthz`));
}

// ── Main loop ─────────────────────────────────────────────────────────
async function main() {
  console.log(`=== Gamerplex Arcade Oracle Bot (${NETWORK}) ===`);
  console.log(`  Program: ${PROGRAM_ID.toBase58()}`);
  console.log(`  RPC:     ${RPC}`);
  console.log(`  Interval: ${PUSH_INTERVAL_SEC}s   Threshold: ${DELTA_BPS_THRESHOLD}bps   Max stale: ${MAX_STALE_BEFORE_PUSH_SEC}s\n`);

  const admin = loadAdmin();
  console.log(`  Bot/admin: ${admin.publicKey.toBase58()}\n`);

  const conn = new Connection(RPC, "confirmed");
  const provider = new AnchorProvider(conn, new Wallet(admin), { commitment: "confirmed" });

  const idlPath = path.join(__dirname, "..", "..", "target", "idl", "gamerplex_arcade.json");
  const idl = JSON.parse(readFileSync(idlPath, "utf8"));
  const program = new Program(idl, provider);

  // Read current rates state into lastSol*/lastGame* before first tick
  try {
    const rates: any = await (program.account as any).exchangeRatesConfig.fetch(ratesPda());
    lastSolScaled = BigInt(rates.solMicroUsdPerLamport.toString());
    lastGameScaled = BigInt(rates.gameMicroUsdPerQuark.toString());
    lastSolPushAt = Number(rates.solUpdatedAt);
    lastGamePushAt = Number(rates.gameUpdatedAt);
    console.log(`bootstrap: lastSolScaled=${lastSolScaled} lastGameScaled=${lastGameScaled}`);
  } catch (e) {
    console.warn(`bootstrap fetch failed (PDA not init yet?):`, (e as Error).message);
  }

  startHealthServer();

  // Tick immediately, then every PUSH_INTERVAL_SEC
  await maybePush(conn, program, admin);
  setInterval(() => maybePush(conn, program, admin), PUSH_INTERVAL_SEC * 1000);
}

main().catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});
