// Localnet coverage — Milestone 2: the cheap, high-value negative/security
// paths that need no memo CPI or payment introspection. Reuses bootstrap().
// Run (validator must be up): npx vitest run tests/localnet/coverage.test.ts
//
// Fills gap-matrix items: AdminOnly (every privileged ix), check_deadline,
// double-init, register_game validation, rotate_season, open_player_profile +
// referral, update_avatar.

import { describe, it, beforeAll, expect } from 'vitest';
import * as anchor from '@coral-xyz/anchor';
import crypto from 'node:crypto';
import {
  Keypair,
  PublicKey,
  Transaction,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  getOrCreateAssociatedTokenAccount,
  getAssociatedTokenAddressSync,
  createTransferCheckedInstruction,
  mintTo,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { bootstrap, airdrop, PDAS, type Ctx } from './bootstrap';

const SPL_MEMO_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const SCORE_COMMIT = 50_000; // micro-USD ($0.05)
const CAT_SCORE_COMMIT = 2;
const USDC_DECIMALS = 6;

let ctx: Ctx;
const now = () => Math.floor(Date.now() / 1000);
const bn = (n: number) => new anchor.BN(n);

// Assert a tx rejects with a specific Anchor error code (by name) — or, for
// raw system errors (double-init), a substring.
async function rejects(p: Promise<unknown>, codeOrMsg: string) {
  try {
    await p;
  } catch (e: unknown) {
    const err = e as {
      error?: { errorCode?: { code?: string } };
      message?: string;
      logs?: string[];
      transactionLogs?: string[];
    };
    const name = err?.error?.errorCode?.code ?? '';
    const logs = (err?.logs ?? err?.transactionLogs ?? []).join('\n');
    const msg = `${String(err?.message ?? e)}\n${logs}`;
    if (name === codeOrMsg || msg.includes(codeOrMsg)) return;
    throw new Error(`expected "${codeOrMsg}", got "${name || msg.slice(0, 200)}"`);
  }
  throw new Error(`expected rejection "${codeOrMsg}" but tx succeeded`);
}

async function fundedPlayer(): Promise<Keypair> {
  const kp = Keypair.generate();
  await airdrop(ctx.conn, kp.publicKey, 2);
  return kp;
}

beforeAll(async () => {
  ctx = await bootstrap();
}, 120_000);

describe('register_game — auth, deadline, validation', () => {
  const okDeadline = () => bn(now() + 3600);

  it('AdminOnly: non-admin signer rejected', async () => {
    // Fund rando — register_game has `payer = admin`, so an unfunded admin
    // account fails on rent before the has_one auth check surfaces.
    const rando = await fundedPlayer();
    await rejects(
      ctx.program.methods
        .registerGame(2, 'g2', 'G2', okDeadline())
        .accounts({ admin: rando.publicKey, game: PDAS.game(2) })
        .signers([rando])
        .rpc(),
      'AdminOnly'
    );
  });

  it('InstructionExpired: past deadline', async () => {
    await rejects(
      ctx.program.methods
        .registerGame(2, 'g2', 'G2', bn(now() - 10))
        .accounts({ admin: ctx.admin.publicKey, game: PDAS.game(2) })
        .rpc(),
      'InstructionExpired'
    );
  });

  it('DeadlineTooFar: >7d future', async () => {
    await rejects(
      ctx.program.methods
        .registerGame(2, 'g2', 'G2', bn(now() + 8 * 86400))
        .accounts({ admin: ctx.admin.publicKey, game: PDAS.game(2) })
        .rpc(),
      'DeadlineTooFar'
    );
  });

  it('SlugTooLong: >16 chars', async () => {
    await rejects(
      ctx.program.methods
        .registerGame(2, 'x'.repeat(17), 'G2', okDeadline())
        .accounts({ admin: ctx.admin.publicKey, game: PDAS.game(2) })
        .rpc(),
      'SlugTooLong'
    );
  });

  it('NameTooLong: >32 chars', async () => {
    await rejects(
      ctx.program.methods
        .registerGame(2, 'g2', 'y'.repeat(33), okDeadline())
        .accounts({ admin: ctx.admin.publicKey, game: PDAS.game(2) })
        .rpc(),
      'NameTooLong'
    );
  });

  it('InvalidGameId: id=0', async () => {
    await rejects(
      ctx.program.methods
        .registerGame(0, 'g0', 'G0', okDeadline())
        .accounts({ admin: ctx.admin.publicKey, game: PDAS.game(0) })
        .rpc(),
      'InvalidGameId'
    );
  });

  it('GameIdMismatch: non-sequential id', async () => {
    await rejects(
      ctx.program.methods
        .registerGame(99, 'g99', 'G99', okDeadline())
        .accounts({ admin: ctx.admin.publicKey, game: PDAS.game(99) })
        .rpc(),
      'GameIdMismatch'
    );
  });

  it('happy: id=2 registers (next sequential)', async () => {
    await ctx.program.methods
      .registerGame(2, 'g2', 'Game 2', okDeadline())
      .accounts({ admin: ctx.admin.publicKey, game: PDAS.game(2) })
      .rpc();
    const info = await ctx.conn.getAccountInfo(PDAS.game(2));
    expect(info).not.toBeNull();
  });
});

describe('double-init', () => {
  it('initialize_config twice rejects (account in use)', async () => {
    await rejects(
      ctx.program.methods
        .initializeConfig(ctx.treasury.publicKey)
        .accounts({ admin: ctx.admin.publicKey })
        .rpc(),
      'already in use'
    );
  });
});

describe('rotate_season', () => {
  it('AdminOnly: non-admin rejected', async () => {
    const rando = Keypair.generate();
    await rejects(
      ctx.program.methods
        .rotateSeason(bn(now() + 3600))
        .accounts({ admin: rando.publicKey })
        .signers([rando])
        .rpc(),
      'AdminOnly'
    );
  });

  it('happy: admin rotates season', async () => {
    await ctx.program.methods
      .rotateSeason(bn(now() + 3600))
      .accounts({ admin: ctx.admin.publicKey })
      .rpc();
  });
});

describe('open_player_profile — referral guards', () => {
  it('happy: opens profile (no referrer)', async () => {
    const p = await fundedPlayer();
    await ctx.program.methods
      .openPlayerProfile(PublicKey.default)
      .accounts({ player: p.publicKey, profile: PDAS.profile(p.publicKey), referrerProfile: null })
      .signers([p])
      .rpc();
    expect(await ctx.conn.getAccountInfo(PDAS.profile(p.publicKey))).not.toBeNull();
  });

  it('double-open rejects', async () => {
    const p = await fundedPlayer();
    const open = () =>
      ctx.program.methods
        .openPlayerProfile(PublicKey.default)
        .accounts({ player: p.publicKey, profile: PDAS.profile(p.publicKey), referrerProfile: null })
        .signers([p])
        .rpc();
    await open();
    await rejects(open(), 'already in use');
  });

  it('SelfReferralNotAllowed: referrer == self', async () => {
    const p = await fundedPlayer();
    // referrer_profile = null: the self-referral check (referrer != player)
    // runs before the referrer_profile requirement, so no account to deser.
    await rejects(
      ctx.program.methods
        .openPlayerProfile(p.publicKey)
        .accounts({ player: p.publicKey, profile: PDAS.profile(p.publicKey), referrerProfile: null })
        .signers([p])
        .rpc(),
      'SelfReferralNotAllowed'
    );
  });

  it('ReferrerProfileRequired: referrer set, no referrer_profile', async () => {
    const p = await fundedPlayer();
    const ref = Keypair.generate();
    await rejects(
      ctx.program.methods
        .openPlayerProfile(ref.publicKey)
        .accounts({ player: p.publicKey, profile: PDAS.profile(p.publicKey), referrerProfile: null })
        .signers([p])
        .rpc(),
      'ReferrerProfileRequired'
    );
  });
});

describe('update_avatar', () => {
  it('happy: source 0 (tile)', async () => {
    const p = await fundedPlayer();
    await ctx.program.methods
      .openPlayerProfile(PublicKey.default)
      .accounts({ player: p.publicKey, profile: PDAS.profile(p.publicKey), referrerProfile: null })
      .signers([p])
      .rpc();
    await ctx.program.methods
      .updateAvatar(0, PublicKey.default, 0)
      .accounts({ player: p.publicKey, wallet: p.publicKey, profile: PDAS.profile(p.publicKey) })
      .signers([p])
      .rpc();
  });

  it('InvalidAvatarSource: source 4', async () => {
    const p = await fundedPlayer();
    await ctx.program.methods
      .openPlayerProfile(PublicKey.default)
      .accounts({ player: p.publicKey, profile: PDAS.profile(p.publicKey), referrerProfile: null })
      .signers([p])
      .rpc();
    await rejects(
      ctx.program.methods
        .updateAvatar(4, PublicKey.default, 0)
        .accounts({ player: p.publicKey, wallet: p.publicKey, profile: PDAS.profile(p.publicKey) })
        .signers([p])
        .rpc(),
      'InvalidAvatarSource'
    );
  });
});

// ── Milestone 3: payment introspection (security-critical) ──────────────
// record_payment + submit_score paired flow over a real USDC TransferChecked,
// the accounts[8]==player regression guard, PaymentsPaused, RequiredPayment-
// Missing, DuplicateIxInTx. game_id=1 (from bootstrap), USDC stablecoin path.
describe('payment introspection (M3)', () => {
  let treasuryAta: PublicKey;

  beforeAll(async () => {
    treasuryAta = (
      await getOrCreateAssociatedTokenAccount(
        ctx.conn, ctx.admin, ctx.usdcMint, ctx.treasury.publicKey
      )
    ).address;
  }, 60_000);

  // Funded player WITH a profile + USDC balance.
  async function setupPayer(usdc = 10_000_000): Promise<Keypair> {
    const p = await fundedPlayer();
    await ctx.program.methods
      .openPlayerProfile(PublicKey.default)
      .accounts({ player: p.publicKey, profile: PDAS.profile(p.publicKey), referrerProfile: null })
      .signers([p])
      .rpc();
    const ata = await getOrCreateAssociatedTokenAccount(ctx.conn, ctx.admin, ctx.usdcMint, p.publicKey);
    await mintTo(ctx.conn, ctx.admin, ctx.usdcMint, ata.address, ctx.admin, usdc);
    return p;
  }

  function transferIx(player: PublicKey, amount: number) {
    return createTransferCheckedInstruction(
      getAssociatedTokenAddressSync(ctx.usdcMint, player),
      ctx.usdcMint,
      treasuryAta,
      player,
      BigInt(amount),
      USDC_DECIMALS,
      [],
      TOKEN_PROGRAM_ID
    );
  }

  function recordPaymentIx(player: PublicKey, amountMicroUsd: number, rawAmount: number) {
    return ctx.program.methods
      .recordPayment(CAT_SCORE_COMMIT, new anchor.BN(amountMicroUsd), ctx.usdcMint, new anchor.BN(rawAmount), Array.from(new Uint8Array(64)), '')
      .accounts({
        config: PDAS.config(),
        stablecoinConfig: PDAS.stablecoins(),
        game: PDAS.game(1),
        profile: PDAS.profile(player),
        wallet: player,
        referrerProfile: null,
        rates: PDAS.rates(),
        affiliateConfig: PDAS.affiliate(),
        player,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        paymentsConfig: PDAS.payments(),
      })
      .instruction();
  }

  function submitScoreIx(player: PublicKey, score: number) {
    const seed = Array.from(crypto.randomBytes(32));
    const moveHash = Array.from(crypto.createHash('sha256').update(Buffer.alloc(0)).digest());
    return ctx.program.methods
      .submitScore('v1_3-stress', new anchor.BN(score), 0, 0, seed, 30, moveHash, '', PublicKey.default)
      .accounts({
        config: PDAS.config(),
        game: PDAS.game(1),
        profile: PDAS.profile(player),
        wallet: player,
        player,
        memoProgram: SPL_MEMO_ID,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        session: null,
      })
      .instruction();
  }

  it('🔴 REGRESSION: record_payment account[8] MUST be player (introspection invariant)', async () => {
    const dummy = Keypair.generate().publicKey;
    const ix = await recordPaymentIx(dummy, SCORE_COMMIT, SCORE_COMMIT);
    // submit_score/commit_replay/mint_receipt read ix.accounts[8] as the payer.
    expect(ix.keys[8].pubkey.equals(dummy)).toBe(true);
  });

  it('happy: USDC transfer + record_payment + submit_score (paired)', async () => {
    const p = await setupPayer();
    const tx = new Transaction()
      .add(transferIx(p.publicKey, SCORE_COMMIT))
      .add(await recordPaymentIx(p.publicKey, SCORE_COMMIT, SCORE_COMMIT))
      .add(await submitScoreIx(p.publicKey, 1000));
    const sig = await sendAndConfirmTransaction(ctx.conn, tx, [p]);
    expect(sig).toBeTruthy();
  });

  it('RequiredPaymentMissing: submit_score with no record_payment', async () => {
    const p = await setupPayer();
    const ix = await submitScoreIx(p.publicKey, 1000);
    await rejects(
      sendAndConfirmTransaction(ctx.conn, new Transaction().add(ix), [p]),
      'RequiredPaymentMissing'
    );
  });

  it('DuplicateIxInTx: two submit_score + one record_payment', async () => {
    const p = await setupPayer();
    const tx = new Transaction()
      .add(transferIx(p.publicKey, SCORE_COMMIT))
      .add(await recordPaymentIx(p.publicKey, SCORE_COMMIT, SCORE_COMMIT))
      .add(await submitScoreIx(p.publicKey, 1000))
      .add(await submitScoreIx(p.publicKey, 1001));
    await rejects(sendAndConfirmTransaction(ctx.conn, tx, [p]), 'DuplicateIxInTx');
  });

  it('InvalidScoreCommitAmount: wrong tier amount', async () => {
    const p = await setupPayer();
    const tx = new Transaction()
      .add(transferIx(p.publicKey, 40_000))
      .add(await recordPaymentIx(p.publicKey, 40_000, 40_000));
    await rejects(sendAndConfirmTransaction(ctx.conn, tx, [p]), 'InvalidScoreCommitAmount');
  });

  it('PaymentsPaused: kill-switch blocks record_payment, unpause restores', async () => {
    await ctx.program.methods
      .setPaymentsPaused(true, new anchor.BN(now() + 3600))
      .accounts({ admin: ctx.admin.publicKey })
      .rpc();
    const p = await setupPayer();
    const tx = new Transaction()
      .add(transferIx(p.publicKey, SCORE_COMMIT))
      .add(await recordPaymentIx(p.publicKey, SCORE_COMMIT, SCORE_COMMIT));
    await rejects(sendAndConfirmTransaction(ctx.conn, tx, [p]), 'PaymentsPaused');
    // restore so later state is clean
    await ctx.program.methods
      .setPaymentsPaused(false, new anchor.BN(now() + 3600))
      .accounts({ admin: ctx.admin.publicKey })
      .rpc();
  });
});

// ── Milestone 4: sessions, receipts (incl. original_player immutability), handle/bio ──
describe('sessions, receipts, handle/bio (M4)', () => {
  let treasuryAta: PublicKey;
  beforeAll(async () => {
    treasuryAta = (
      await getOrCreateAssociatedTokenAccount(ctx.conn, ctx.admin, ctx.usdcMint, ctx.treasury.publicKey)
    ).address;
  }, 60_000);

  async function payer(usdc = 10_000_000): Promise<Keypair> {
    const p = await fundedPlayer();
    await ctx.program.methods
      .openPlayerProfile(PublicKey.default)
      .accounts({ player: p.publicKey, profile: PDAS.profile(p.publicKey), referrerProfile: null })
      .signers([p])
      .rpc();
    const ata = await getOrCreateAssociatedTokenAccount(ctx.conn, ctx.admin, ctx.usdcMint, p.publicKey);
    await mintTo(ctx.conn, ctx.admin, ctx.usdcMint, ata.address, ctx.admin, usdc);
    return p;
  }
  const xfer = (player: PublicKey, amt: number) =>
    createTransferCheckedInstruction(
      getAssociatedTokenAddressSync(ctx.usdcMint, player), ctx.usdcMint, treasuryAta, player,
      BigInt(amt), USDC_DECIMALS, [], TOKEN_PROGRAM_ID
    );
  const recPay = (player: PublicKey, cat: number, amt: number) =>
    ctx.program.methods
      .recordPayment(cat, new anchor.BN(amt), ctx.usdcMint, new anchor.BN(amt), Array.from(new Uint8Array(64)), '')
      .accounts({
        config: PDAS.config(), stablecoinConfig: PDAS.stablecoins(), game: PDAS.game(1),
        profile: PDAS.profile(player), wallet: player, referrerProfile: null, rates: PDAS.rates(),
        affiliateConfig: PDAS.affiliate(), player, instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        paymentsConfig: PDAS.payments(),
      })
      .instruction();
  const setHandleAccts = (player: PublicKey, handle: string) => ({
    profileExt: PDAS.profileExt(player), oldHandleClaim: null,
    newHandleClaim: PDAS.handleClaim(handle), player,
  });

  it('update_bio happy + BioTooLong', async () => {
    const p = await fundedPlayer();
    await ctx.program.methods.updateBio('gm').accounts({ profileExt: PDAS.profileExt(p.publicKey), player: p.publicKey }).signers([p]).rpc();
    await rejects(
      ctx.program.methods.updateBio('x'.repeat(141)).accounts({ profileExt: PDAS.profileExt(p.publicKey), player: p.publicKey }).signers([p]).rpc(),
      'BioTooLong'
    );
  });

  it('set_handle happy', async () => {
    const p = await fundedPlayer();
    await ctx.program.methods.setHandle('alice123').accounts(setHandleAccts(p.publicKey, 'alice123')).signers([p]).rpc();
    expect(await ctx.conn.getAccountInfo(PDAS.handleClaim('alice123'))).not.toBeNull();
  });

  it('HandleTooShort + HandleReserved', async () => {
    const p = await fundedPlayer();
    await rejects(ctx.program.methods.setHandle('ab').accounts(setHandleAccts(p.publicKey, 'ab')).signers([p]).rpc(), 'HandleTooShort');
    await rejects(ctx.program.methods.setHandle('admin').accounts(setHandleAccts(p.publicKey, 'admin')).signers([p]).rpc(), 'HandleReserved');
  });

  it('handle uniqueness: second claim of a taken handle rejects', async () => {
    const p1 = await fundedPlayer();
    const p2 = await fundedPlayer();
    await ctx.program.methods.setHandle('bob').accounts(setHandleAccts(p1.publicKey, 'bob')).signers([p1]).rpc();
    await rejects(ctx.program.methods.setHandle('bob').accounts(setHandleAccts(p2.publicKey, 'bob')).signers([p2]).rpc(), 'already in use');
  });

  it('open_session happy + InvalidSessionLifetime', async () => {
    const p = await fundedPlayer();
    const seed = Array.from(crypto.randomBytes(32));
    await ctx.program.methods.openSession(new anchor.BN(1), 1, seed, 3600)
      .accounts({ session: PDAS.session(p.publicKey, 1), player: p.publicKey, funder: p.publicKey }).signers([p]).rpc();
    expect(await ctx.conn.getAccountInfo(PDAS.session(p.publicKey, 1))).not.toBeNull();
    await rejects(
      ctx.program.methods.openSession(new anchor.BN(2), 1, seed, 30)
        .accounts({ session: PDAS.session(p.publicKey, 2), player: p.publicKey, funder: p.publicKey }).signers([p]).rpc(),
      'InvalidSessionLifetime'
    );
  });

  it('receipt: mint → transfer (original_player IMMUTABLE) → NotReceiptOwner → close', async () => {
    const p = await payer();
    const nonce = 7;
    const seed = Array.from(crypto.randomBytes(32));
    const moveHash = Array.from(crypto.createHash('sha256').update(Buffer.alloc(0)).digest());
    const mintIx = await ctx.program.methods
      .mintReplayReceipt(new anchor.BN(nonce), new anchor.BN(5000), 0, 0, seed, moveHash, 30, Array.from(new Uint8Array(64)))
      .accounts({ config: PDAS.config(), game: PDAS.game(1), receipt: PDAS.receipt(p.publicKey, nonce), player: p.publicKey, instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY })
      .instruction();
    await sendAndConfirmTransaction(
      ctx.conn,
      new Transaction().add(xfer(p.publicKey, 250_000)).add(await recPay(p.publicKey, 5, 250_000)).add(mintIx),
      [p]
    );
    const rkey = PDAS.receipt(p.publicKey, nonce);
    const acct = (ctx.program.account as Record<string, { fetch: (k: PublicKey) => Promise<{ owner: PublicKey; originalPlayer: PublicKey }> }>).replayReceipt;
    let r = await acct.fetch(rkey);
    expect(r.owner.toBase58()).toBe(p.publicKey.toBase58());
    expect(r.originalPlayer.toBase58()).toBe(p.publicKey.toBase58());

    const newOwner = Keypair.generate();
    await ctx.program.methods.transferReplayReceipt(newOwner.publicKey).accounts({ receipt: rkey, owner: p.publicKey }).signers([p]).rpc();
    r = await acct.fetch(rkey);
    expect(r.owner.toBase58()).toBe(newOwner.publicKey.toBase58());
    expect(r.originalPlayer.toBase58()).toBe(p.publicKey.toBase58()); // never reassigned

    await rejects(
      ctx.program.methods.transferReplayReceipt(p.publicKey).accounts({ receipt: rkey, owner: p.publicKey }).signers([p]).rpc(),
      'NotReceiptOwner'
    );

    await airdrop(ctx.conn, newOwner.publicKey, 1);
    await ctx.program.methods.closeReplayReceipt().accounts({ receipt: rkey, owner: newOwner.publicKey }).signers([newOwner]).rpc();
    expect(await ctx.conn.getAccountInfo(rkey)).toBeNull();
  });
});

// ── Milestone 5: commit_session_replay (last money ix) + remaining admin setters ──
describe('replay-commit + admin setters (M5)', () => {
  let treasuryAta: PublicKey;
  beforeAll(async () => {
    treasuryAta = (await getOrCreateAssociatedTokenAccount(ctx.conn, ctx.admin, ctx.usdcMint, ctx.treasury.publicKey)).address;
  }, 60_000);

  async function payer(usdc = 10_000_000): Promise<Keypair> {
    const p = await fundedPlayer();
    await ctx.program.methods.openPlayerProfile(PublicKey.default)
      .accounts({ player: p.publicKey, profile: PDAS.profile(p.publicKey), referrerProfile: null }).signers([p]).rpc();
    const ata = await getOrCreateAssociatedTokenAccount(ctx.conn, ctx.admin, ctx.usdcMint, p.publicKey);
    await mintTo(ctx.conn, ctx.admin, ctx.usdcMint, ata.address, ctx.admin, usdc);
    return p;
  }
  const xfer = (player: PublicKey, amt: number) =>
    createTransferCheckedInstruction(getAssociatedTokenAddressSync(ctx.usdcMint, player), ctx.usdcMint, treasuryAta, player, BigInt(amt), USDC_DECIMALS, [], TOKEN_PROGRAM_ID);
  const recPay = (player: PublicKey, cat: number, amt: number) =>
    ctx.program.methods.recordPayment(cat, new anchor.BN(amt), ctx.usdcMint, new anchor.BN(amt), Array.from(new Uint8Array(64)), '')
      .accounts({ config: PDAS.config(), stablecoinConfig: PDAS.stablecoins(), game: PDAS.game(1), profile: PDAS.profile(player), wallet: player, referrerProfile: null, rates: PDAS.rates(), affiliateConfig: PDAS.affiliate(), player, instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY, paymentsConfig: PDAS.payments() }).instruction();
  const commitIx = (player: PublicKey, nonce: number, moveLog: Buffer) =>
    ctx.program.methods.commitSessionReplay(new anchor.BN(nonce), Array.from(crypto.randomBytes(32)), moveLog)
      .accounts({ player, memoProgram: SPL_MEMO_ID, instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY }).instruction();

  it('commit_session_replay happy (paired $0.15 VERIFIED_COMMIT)', async () => {
    const p = await payer();
    const tx = new Transaction()
      .add(xfer(p.publicKey, 150_000))
      .add(await recPay(p.publicKey, 4, 150_000))
      .add(await commitIx(p.publicKey, 1, Buffer.from([1, 2, 3, 4])));
    expect(await sendAndConfirmTransaction(ctx.conn, tx, [p])).toBeTruthy();
  });

  it('MoveLogEmpty', async () => {
    const p = await payer();
    await rejects(sendAndConfirmTransaction(ctx.conn, new Transaction().add(await commitIx(p.publicKey, 2, Buffer.alloc(0))), [p]), 'MoveLogEmpty');
  });

  it('MoveLogTooLong (>400 bytes)', async () => {
    const p = await payer();
    await rejects(sendAndConfirmTransaction(ctx.conn, new Transaction().add(await commitIx(p.publicKey, 3, Buffer.alloc(401))), [p]), 'MoveLogTooLong');
  });

  it('update_exchange_rates: AdminOnly + happy', async () => {
    const rando = Keypair.generate();
    await rejects(ctx.program.methods.updateExchangeRates(bn(2), bn(2), bn(now() + 3600)).accounts({ admin: rando.publicKey }).signers([rando]).rpc(), 'AdminOnly');
    await ctx.program.methods.updateExchangeRates(bn(2), bn(2), bn(now() + 3600)).accounts({ admin: ctx.admin.publicKey }).rpc();
  });

  it('update_accepted_stablecoins: AdminOnly + happy', async () => {
    const rando = Keypair.generate();
    const mints = [ctx.usdcMint, ...Array(7).fill(PublicKey.default)];
    await rejects(ctx.program.methods.updateAcceptedStablecoins(mints, bn(now() + 3600)).accounts({ admin: rando.publicKey }).signers([rando]).rpc(), 'AdminOnly');
    await ctx.program.methods.updateAcceptedStablecoins(mints, bn(now() + 3600)).accounts({ admin: ctx.admin.publicKey }).rpc();
  });

  it('set_affiliate_min_accrual: AffiliateMinAccrualTooLow + happy', async () => {
    await rejects(ctx.program.methods.setAffiliateMinAccrual(bn(5_000), bn(now() + 3600)).accounts({ admin: ctx.admin.publicKey }).rpc(), 'AffiliateMinAccrualTooLow');
    await ctx.program.methods.setAffiliateMinAccrual(bn(200_000), bn(now() + 3600)).accounts({ admin: ctx.admin.publicKey }).rpc();
  });
});

// ── Milestone 6: payment bounds + category guard (no transfer — these checks
// fire before transfer verification, so they're cheap). ──
describe('payment bounds (M6)', () => {
  async function profiled(): Promise<Keypair> {
    const p = await fundedPlayer();
    await ctx.program.methods.openPlayerProfile(PublicKey.default)
      .accounts({ player: p.publicKey, profile: PDAS.profile(p.publicKey), referrerProfile: null }).signers([p]).rpc();
    return p;
  }
  const recPayIx = (player: PublicKey, cat: number, amount: number) =>
    ctx.program.methods.recordPayment(cat, new anchor.BN(amount), ctx.usdcMint, new anchor.BN(amount), Array.from(new Uint8Array(64)), '')
      .accounts({
        config: PDAS.config(), stablecoinConfig: PDAS.stablecoins(), game: PDAS.game(1),
        profile: PDAS.profile(player), wallet: player, referrerProfile: null, rates: PDAS.rates(),
        affiliateConfig: PDAS.affiliate(), player, instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        paymentsConfig: PDAS.payments(),
      }).instruction();
  const sendRecPay = async (p: Keypair, cat: number, amount: number) =>
    sendAndConfirmTransaction(ctx.conn, new Transaction().add(await recPayIx(p.publicKey, cat, amount)), [p]);

  it('PaymentBelowMin: CONTINUE amount < $0.01 (10_000 micro)', async () => {
    await rejects(sendRecPay(await profiled(), 0, 5_000), 'PaymentBelowMin');
  });
  it('PaymentAboveMax: amount > $100 (100_000_000 micro)', async () => {
    await rejects(sendRecPay(await profiled(), 0, 200_000_000), 'PaymentAboveMax');
  });
  it('InvalidPaymentCategory: category > CNFT_WRAP(6)', async () => {
    await rejects(sendRecPay(await profiled(), 7, 50_000), 'InvalidPaymentCategory');
  });
});
