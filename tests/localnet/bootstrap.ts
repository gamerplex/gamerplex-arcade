// Localnet bootstrap — Milestone 1 of the free exhaustive harness.
//
// Boots against a running `solana-test-validator` (loaded with the arcade .so),
// funds an admin via UNLIMITED local airdrop, and initializes every config PDA.
// Run: tsx tests/localnet/bootstrap.ts  (validator must already be running)
//
// This is the shared setup every coverage test reuses — zero devnet cost.

import * as anchor from '@coral-xyz/anchor';
import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { createMint } from '@solana/spl-token';
import idl from '../../target/idl/gamerplex_arcade.json' assert { type: 'json' };

export const RPC = process.env.LOCALNET_RPC || 'http://127.0.0.1:8899';
export const PROGRAM_ID = new PublicKey(
  '4FVwdxxBp6PTax2tAcPyHE9rYt8tyNf2YBGrSnSqmx8t'
);

const enc = (s: string) => Buffer.from(s, 'utf8');
const le8 = (n: number | bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};
export function pda(seeds: (Buffer | Uint8Array)[]): PublicKey {
  return PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];
}
export const PDAS = {
  config: () => pda([enc('config')]),
  stablecoins: () => pda([enc('stablecoins')]),
  rates: () => pda([enc('rates')]),
  affiliate: () => pda([enc('affiliate')]),
  payments: () => pda([enc('payments')]),
  game: (id: number) => pda([enc('game'), Buffer.from([id])]),
  profile: (w: PublicKey) => pda([enc('profile'), w.toBuffer()]),
  session: (w: PublicKey, nonce: number | bigint) => pda([enc('session'), w.toBuffer(), le8(nonce)]),
  receipt: (w: PublicKey, nonce: number | bigint) => pda([enc('receipt'), w.toBuffer(), le8(nonce)]),
  profileExt: (w: PublicKey) => pda([enc('profile-ext'), w.toBuffer()]),
  handleClaim: (handle: string) => pda([enc('handle-claim'), enc(handle)]),
  resolverConfig: () => pda([enc('resolver')]),
};

export async function airdrop(conn: Connection, to: PublicKey, sol = 100) {
  const sig = await conn.requestAirdrop(to, sol * LAMPORTS_PER_SOL);
  await conn.confirmTransaction(sig, 'confirmed');
}

export interface Ctx {
  conn: Connection;
  admin: Keypair;
  treasury: Keypair;
  resolver: Keypair;
  program: anchor.Program;
  usdcMint: PublicKey;
}

export async function bootstrap(): Promise<Ctx> {
  const conn = new Connection(RPC, 'confirmed');
  const admin = Keypair.generate();
  const treasury = Keypair.generate();
  await airdrop(conn, admin.publicKey, 100);

  const provider = new anchor.AnchorProvider(
    conn,
    new anchor.Wallet(admin),
    { commitment: 'confirmed' }
  );
  // anchor 0.31: program id comes from idl.address
  const program = new anchor.Program(idl as anchor.Idl, provider);

  const log = (s: string) => console.log(`  ${s}`);

  // 1) config
  await program.methods
    .initializeConfig(treasury.publicKey)
    .accounts({ admin: admin.publicKey })
    .rpc();
  log('✓ initialize_config');

  // 2) stablecoins — test USDC (6 decimals) in slot 0, rest default
  const usdcMint = await createMint(conn, admin, admin.publicKey, null, 6);
  const mints = [usdcMint, ...Array(7).fill(PublicKey.default)];
  await program.methods
    .initializeStablecoins(mints)
    .accounts({ admin: admin.publicKey })
    .rpc();
  log(`✓ initialize_stablecoins (USDC=${usdcMint.toBase58().slice(0, 8)}…)`);

  // 3) exchange rates — non-zero (real math tested later)
  await program.methods
    .initializeExchangeRates(new anchor.BN(1), new anchor.BN(1))
    .accounts({ admin: admin.publicKey })
    .rpc();
  log('✓ initialize_exchange_rates');

  // 4) affiliate config — 150_000 micro-usd min accrual
  await program.methods
    .initializeAffiliateConfig(new anchor.BN(150_000))
    .accounts({ admin: admin.publicKey })
    .rpc();
  log('✓ initialize_affiliate_config');

  // 5) payments config (kill-switch, paused=false)
  await program.methods
    .initializePaymentsConfig()
    .accounts({ admin: admin.publicKey })
    .rpc();
  log('✓ initialize_payments_config');

  // 6) register game id=1
  const deadline = new anchor.BN(Math.floor(Date.now() / 1000) + 3600);
  await program.methods
    .registerGame(1, 'test-game', 'Test Game', deadline)
    .accounts({ admin: admin.publicKey, game: PDAS.game(1) })
    .rpc();
  log('✓ register_game(1)');

  // 7) resolver authority — the service key that issues sessions + attests receipts
  const resolver = Keypair.generate();
  await airdrop(conn, resolver.publicKey, 100);
  await program.methods
    .setResolver(resolver.publicKey, deadline)
    .accounts({ admin: admin.publicKey })
    .rpc();
  log('✓ set_resolver');

  // verify every PDA exists + is program-owned
  for (const [name, key] of [
    ['config', PDAS.config()],
    ['stablecoins', PDAS.stablecoins()],
    ['rates', PDAS.rates()],
    ['affiliate', PDAS.affiliate()],
    ['payments', PDAS.payments()],
    ['game(1)', PDAS.game(1)],
  ] as const) {
    const info = await conn.getAccountInfo(key);
    if (!info || !info.owner.equals(PROGRAM_ID)) {
      throw new Error(`PDA ${name} missing or not program-owned`);
    }
  }
  log('✓ all config PDAs verified program-owned');
  return { conn, admin, treasury, resolver, program, usdcMint };
}

// Run standalone
if (import.meta.url === `file://${process.argv[1]}`) {
  bootstrap()
    .then(() => {
      console.log('\nMILESTONE 1: bootstrap PASS (free localnet)');
      process.exit(0);
    })
    .catch((e) => {
      console.error('\nMILESTONE 1: FAIL\n', e);
      process.exit(1);
    });
}
