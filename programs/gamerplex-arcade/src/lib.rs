// Gamerplex Arcade — unified program for all first-party solo arcade games.
//
// Scope (v1):
//   * Admin configures the arcade once, registers games, rotates seasons.
//   * Players open a PlayerProfile PDA on first interaction (tracks cross-game
//     stats + avatar preference + cosmetic ownership bitmap).
//   * submit_score: player commits a session result. Emits a GPX5 v2 memo so
//     anyone can reconstruct every leaderboard from Solana tx history.
//   * record_payment: ties a Solana Pay / Flipcash tx signature to a specific
//     game action (continue / powerup / score commit / cosmetic). Gives users
//     an auditable trail of what they paid for.
//
// Not in v1 (deliberate):
//   * On-chain top-K leaderboard PDA. The resolver computes leaderboards by
//     scanning GPX5 memos. Same pattern Contention Markets uses for match
//     history — the resolver is a cache, not the source of truth.
//   * VIP staking logic (Phase 5, separate upgrade).
//   * Cosmetic unlock purchase flows (Phase 3).
//   * On-chain move-log replay (opt-in via future SessionReplay PDA).
//
// First registered game: Cyber Snake (game_id = 1, slug = "cyber-snake").

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::Instruction,
    program::invoke,
    sysvar::instructions as ix_sysvar,
};
use anchor_lang::Discriminator;
use solana_security_txt::security_txt;

declare_id!("4FVwdxxBp6PTax2tAcPyHE9rYt8tyNf2YBGrSnSqmx8t");

security_txt! {
    name: "Gamerplex Arcade",
    project_url: "https://gamerplex.com",
    contacts: "email:security@gamerplex.com",
    policy: "https://gamerplex.com/security",
    preferred_languages: "en",
    source_code: "https://github.com/gamerplex/gamerplex-arcade"
}

// SPL Memo program — we CPI into it to emit GPX5 strings on every score.
// https://spl.solana.com/memo
pub const SPL_MEMO_ID: Pubkey =
    solana_program::pubkey!("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

// Seeds
pub const CONFIG_SEED: &[u8] = b"config";
pub const GAME_SEED: &[u8] = b"game";
pub const PROFILE_SEED: &[u8] = b"profile";
pub const RECEIPT_SEED: &[u8] = b"receipt";
pub const STABLECOINS_SEED: &[u8] = b"stablecoins";
pub const PROFILE_EXT_SEED: &[u8] = b"profile-ext";
pub const HANDLE_CLAIM_SEED: &[u8] = b"handle-claim";
pub const RATES_SEED: &[u8] = b"rates";

// SPL Token program IDs (used for introspecting token transfers in-tx).
pub const SPL_TOKEN_PROGRAM_ID: Pubkey =
    solana_program::pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
pub const SPL_ATA_PROGRAM_ID: Pubkey =
    solana_program::pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

// Max accepted stablecoin mints. Admin can add up to 8 via update_accepted_stablecoins.
pub const MAX_STABLECOIN_SLOTS: usize = 8;

// Admin-instruction deadline ceiling — pre-signed admin txs more than this many
// seconds in the future are rejected.
pub const MAX_DEADLINE_FUTURE_SEC: i64 = 7 * 86_400; // 1 week

// Limits — keep PDAs bounded so rent stays predictable.
pub const MAX_GAME_SLUG_LEN: usize = 16;
pub const MAX_GAME_NAME_LEN: usize = 32;
pub const MAX_VARIANT_LEN: usize = 32;
pub const MAX_META_LEN: usize = 64;
pub const MAX_MEMO_LEN: usize = 450; // well under Solana's 1232-byte legacy memo ceiling

// ProfileExtV2 / HandleClaim identity-layer limits.
pub const MIN_HANDLE_LEN: usize = 3;
pub const MAX_HANDLE_LEN: usize = 32;
pub const MAX_BIO_LEN: usize = 140;

// Reserved handles — global blacklist enforced by set_handle. Adding more is a
// program upgrade. Order doesn't matter; comparisons are linear scan over a
// short list.
pub const RESERVED_HANDLES: &[&str] = &[
    "admin", "system", "root", "null", "anonymous", "deleted",
    "gamerplex", "sledgit", "petlegends", "pltcg",
    "support", "help", "official", "team", "mod",
];

// Cross-game cosmetic ownership: 16 × u32 = 512 one-bit slots.
pub const COSMETIC_BITMAP_WORDS: usize = 16;

// ── Affiliate program constants ─────────────────────────────────────────
// Tail window: referrer earns cut on the referred player's first 10 payments
// OR for 30 days from profile-open, whichever is hit first. After that, the
// relationship is dead — no more accrual. Bounded leakage.
pub const AFFILIATE_TAIL_PAYMENTS: u8 = 10;
pub const AFFILIATE_TAIL_WINDOW_SEC: i64 = 30 * 86_400;
// 20% of the payment amount is credited to the referrer. Matches Tournament
// rake split (20% of protocol fee) documented in AFFILIATE_PROGRAM.md.
pub const AFFILIATE_CUT_BPS: u64 = 2000; // 2000 basis points = 20%
// Payment-amount sanity bounds. Blocks both dust-spam farming (min floor)
// and inflated-amount attacks (max ceiling). $0.01 – $100 USD in micro-USD.
pub const MIN_PAYMENT_MICRO_USD: u64 = 10_000; // $0.01
pub const MAX_PAYMENT_MICRO_USD: u64 = 100_000_000; // $100.00

// Tiered Gamerplex fees (base = $0.05, replay = 3×, cNFT = 5×).
// All prices in micro-USD (USDC uses 6 decimals, so 50_000 = $0.05).
//
// Save-score: player pays $0.05 to commit their score + GPX5 memo to chain.
// Save-replay: player pays $0.15 to inline the full move log as GPX5R memo.
// cNFT mint (v1.2): player pays $0.25 to mint a tradeable replay NFT.
//
// These are PLATFORM fees — distinct from Solana gas (~$0.001) and the
// one-time PlayerProfile rent-exempt deposit (~$0.41 refundable), which are
// infrastructure costs the player pays to Solana, not to Gamerplex.
pub const SCORE_COMMIT_MICRO_USD: u64 = 50_000;        // $0.05 — T1 Save score
pub const VERIFIED_COMMIT_MICRO_USD: u64 = 150_000;    // $0.15 — T2 Save replay
pub const REPLAY_RECEIPT_MICRO_USD: u64 = 250_000;     // $0.25 — T3 Mint ReplayReceipt PDA
pub const CNFT_WRAP_MICRO_USD: u64 = 500_000;          // $0.50 — T4 Wrap as cNFT (v1.3 Bubblegum)
// Category IDs for record_payment.
pub const CATEGORY_CONTINUE: u8 = 0;
pub const CATEGORY_POWERUP: u8 = 1;
pub const CATEGORY_SCORE_COMMIT: u8 = 2;    // T1
pub const CATEGORY_COSMETIC: u8 = 3;
pub const CATEGORY_VERIFIED_COMMIT: u8 = 4; // T2
pub const CATEGORY_REPLAY_RECEIPT: u8 = 5;  // T3 (was CNFT_MINT — renamed)
pub const CATEGORY_CNFT_WRAP: u8 = 6;       // T4
// Max length of the external_ref string (Arweave tx IDs are 43 chars base64url).
pub const MAX_EXTERNAL_REF_LEN: usize = 64;

// On-chain move-log storage for VERIFIED runs. The log goes directly into an
// SPL memo as `GPX5R|<player>|<score_nonce>|<seed_b58>|<move_log_b64>`. At
// 400 bytes of binary move-data (≈540 chars base64), we comfortably fit
// inside the per-tx memo budget (~500-800 bytes practical). Games whose
// sessions routinely exceed this can fall back to external_ref (Arweave).
pub const MAX_MOVE_LOG_BYTES: usize = 400;
pub const MAX_REPLAY_MEMO_LEN: usize = 700;

// Encoded base58 string lengths for 32-byte arrays (used for seed + move_hash).
// bs58 of 32 bytes is variable up to 44 chars. We render into a Vec<u8> at
// emit time.

// ── Multi-token payment constants (v1.3) ────────────────────────────────
// $GAME mint is compile-time per network so the binary literally cannot
// decode a transfer of a different mint as $GAME. Build mainnet artifact
// with `anchor build -- --features mainnet`.
#[cfg(feature = "mainnet")]
pub const GAME_TOKEN_MINT: Pubkey =
    solana_program::pubkey!("7TTBUfDomCKBMemv7FF37Tg3y52cRkAxn8vJnvKD4rsE");
#[cfg(not(feature = "mainnet"))]
pub const GAME_TOKEN_MINT: Pubkey =
    solana_program::pubkey!("8eGnj5jkW6zTGYieGhtejPjLtGmnKfCdk7FamoJ5LLvD");

pub const GAME_TOKEN_DECIMALS: u8 = 10;
pub const STABLECOIN_DECIMALS: u8 = 6;

// Off-chain bot pushes rates every 15min. SOL moves ~5-10%/day, $GAME is
// near-zero velocity pre-Jupiter — tighten $GAME window to 6hr post-listing.
pub const MAX_RATE_STALENESS_SOL_SEC: i64 = 3_600;        // 1 hour
pub const MAX_RATE_STALENESS_GAME_SEC: i64 = 24 * 3_600;  // 24 hours

// Tolerance on rate-converted payments. Frontend must overpay slightly
// (see RATE_OVERPAY_BPS in client.ts) to stay above this floor.
pub const PAYMENT_SLIPPAGE_BPS: u64 = 100;  // 1%

// Rates are stored scaled ×1e12 (micro-USD per smallest unit). At SOL=$150,
// 1 lamport = 0.15 micro-USD → store as 150_000_000_000. Division on use.
pub const RATE_SCALE_FACTOR: u128 = 1_000_000_000_000;

#[program]
pub mod gamerplex_arcade {
    use super::*;

    // ========================================================================
    // Admin setup
    // ========================================================================

    /// One-time initialization of the arcade. Only callable once per program
    /// (seeds = ["config"] PDA, `init` fails if already open).
    pub fn initialize_config(
        ctx: Context<InitializeConfig>,
        treasury_wallet: Pubkey,
    ) -> Result<()> {
        let cfg = &mut ctx.accounts.config;
        cfg.admin = ctx.accounts.admin.key();
        cfg.treasury_wallet = treasury_wallet;
        cfg.current_season = 1;
        cfg.next_game_id = 1;
        cfg.total_games_registered = 0;
        cfg.total_score_commits = 0;
        cfg.total_profiles_opened = 0;
        cfg.bump = ctx.bumps.config;
        emit!(ConfigInitialized {
            admin: cfg.admin,
            treasury_wallet,
        });
        Ok(())
    }

    /// Register a new arcade game. Admin-only. Each game_id is permanent.
    /// First call after initialize_config should register Cyber Snake
    /// (game_id = 1, slug = "cyber-snake").
    pub fn register_game(
        ctx: Context<RegisterGame>,
        game_id: u8,
        slug: String,
        display_name: String,
        deadline: i64,
    ) -> Result<()> {
        check_deadline(deadline)?;
        require!(slug.len() <= MAX_GAME_SLUG_LEN, ArcadeError::SlugTooLong);
        require!(
            display_name.len() <= MAX_GAME_NAME_LEN,
            ArcadeError::NameTooLong
        );
        require!(game_id > 0, ArcadeError::InvalidGameId);

        // Enforce monotonically increasing game_id for predictability.
        let cfg = &mut ctx.accounts.config;
        require!(
            game_id == cfg.next_game_id,
            ArcadeError::GameIdMismatch
        );
        cfg.next_game_id = cfg
            .next_game_id
            .checked_add(1)
            .ok_or(ArcadeError::GameIdOverflow)?;
        cfg.total_games_registered = cfg
            .total_games_registered
            .checked_add(1)
            .ok_or(ArcadeError::Overflow)?;

        let game = &mut ctx.accounts.game;
        game.game_id = game_id;
        game.slug = slug.clone();
        game.display_name = display_name.clone();
        game.total_sessions = 0;
        game.total_score_commits = 0;
        game.created_at = Clock::get()?.unix_timestamp;
        game.bump = ctx.bumps.game;

        emit!(GameRegistered {
            game_id,
            slug,
            display_name,
        });
        Ok(())
    }

    // ========================================================================
    // Player onboarding
    // ========================================================================

    /// Open a PlayerProfile PDA for a wallet. Called once per wallet, by the
    /// wallet itself (anyone pays their own rent). Idempotent via `init`.
    ///
    /// If the caller arrived via a challenge link and wants to attribute their
    /// referral, they pass `referrer = Some(<challenger_pubkey>)`. The
    /// challenger MUST have an already-open PlayerProfile (passed in the
    /// accounts as `referrer_profile`) — this blocks attribution to arbitrary
    /// wallets and guarantees the referrer is a real Gamerplex participant.
    /// Self-referral is rejected. The referrer becomes IMMUTABLE after this
    /// call — first-refer-wins, no switcheroos.
    // `referrer` semantics: pass Pubkey::default() (all zeros) for
    // "no referrer". Any other pubkey is treated as an active referrer and
    // must match the `referrer_profile` account passed in the context.
    pub fn open_player_profile(
        ctx: Context<OpenPlayerProfile>,
        referrer: Pubkey,
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let player_key = ctx.accounts.player.key();
        let p = &mut ctx.accounts.profile;
        p.wallet = player_key;
        p.total_sessions = 0;
        p.total_score_commits = 0;
        p.total_spent_usdc_micro = 0;
        p.total_spent_gamer_micro = 0;
        p.total_gamer_earned = 0;
        p.favorite_game_id = 0;
        p.vip_stake_amount = 0;
        p.cosmetics_owned = [0u32; COSMETIC_BITMAP_WORDS];
        p.avatar_source = 0;
        p.nft_pfp_mint = Pubkey::default();
        p.cosmetic_avatar_id = 0;
        p.created_at = now;

        // ── Affiliate attribution ──────────────────────────────────────
        // Defense #1: self-referral prohibited.
        // Defense #2: referrer must have an existing PlayerProfile (enforced
        //   by the account constraint on referrer_profile in OpenPlayerProfile;
        //   when referrer is None, the account is optional/ignored).
        // Defense #3: referrer is IMMUTABLE after this call (we only set it
        //   here, never mutate elsewhere).
        if referrer != Pubkey::default() {
            require!(referrer != player_key, ArcadeError::SelfReferralNotAllowed);
            // The referrer_profile PDA is seeds-constrained to `referrer`,
            // guaranteeing it's the real profile for that wallet. Anchor's
            // `init`-already-done check on the passed account (via the
            // seeds constraint) enforces that referrer's profile must exist.
            let referrer_profile = ctx
                .accounts
                .referrer_profile
                .as_ref()
                .ok_or(ArcadeError::ReferrerProfileRequired)?;
            require!(
                referrer_profile.wallet == referrer,
                ArcadeError::ReferrerProfileMismatch
            );
            p.referrer = referrer;
            p.referrer_expires_at = now
                .checked_add(AFFILIATE_TAIL_WINDOW_SEC)
                .ok_or(ArcadeError::Overflow)?;
            p.referrer_payments_remaining = AFFILIATE_TAIL_PAYMENTS;
        } else {
            p.referrer = Pubkey::default();
            p.referrer_expires_at = 0;
            p.referrer_payments_remaining = 0;
        }
        p.total_referred_payouts_micro = 0;
        p.affiliate_earned_accrued_micro = 0;
        p.affiliate_earned_lifetime_micro = 0;
        p.affiliate_referred_payers = 0;
        p.bump = ctx.bumps.profile;

        let cfg = &mut ctx.accounts.config;
        cfg.total_profiles_opened = cfg
            .total_profiles_opened
            .checked_add(1)
            .ok_or(ArcadeError::Overflow)?;

        if p.referrer != Pubkey::default() {
            emit!(AffiliateAttributed {
                player: p.wallet,
                referrer: p.referrer,
                expires_at: p.referrer_expires_at,
                payments_allotted: AFFILIATE_TAIL_PAYMENTS,
            });
        }
        emit!(ProfileOpened {
            wallet: p.wallet,
            created_at: p.created_at,
            referrer: p.referrer,
        });
        Ok(())
    }

    /// Update avatar source preference. Fully off-chain-resolvable:
    ///   0 = fallback color tile (client-generated from wallet hash)
    ///   1 = SNS picture record (resolver does reverse-lookup)
    ///   2 = NFT PFP (nft_pfp_mint used)
    ///   3 = Gamerplex cosmetic (cosmetic_avatar_id used; must be owned)
    pub fn update_avatar(
        ctx: Context<UpdateAvatar>,
        avatar_source: u8,
        nft_pfp_mint: Pubkey,
        cosmetic_avatar_id: u16,
    ) -> Result<()> {
        require!(avatar_source <= 3, ArcadeError::InvalidAvatarSource);
        let p = &mut ctx.accounts.profile;
        // If using a cosmetic avatar, enforce ownership (bit set in bitmap).
        if avatar_source == 3 {
            let idx = cosmetic_avatar_id as usize;
            let word = idx / 32;
            let bit = idx % 32;
            require!(word < COSMETIC_BITMAP_WORDS, ArcadeError::InvalidCosmeticId);
            require!(
                (p.cosmetics_owned[word] & (1u32 << bit)) != 0,
                ArcadeError::CosmeticNotOwned
            );
        }
        p.avatar_source = avatar_source;
        p.nft_pfp_mint = nft_pfp_mint;
        p.cosmetic_avatar_id = cosmetic_avatar_id;
        Ok(())
    }

    // ========================================================================
    // The main loop — score commits + payment records
    // ========================================================================

    /// Submit a completed session score. Emits a GPX5 v2 memo via CPI to the
    /// SPL Memo program. Indexers scan memos to build leaderboards — no
    /// on-chain leaderboard PDA in v1.
    ///
    /// Memo format:
    ///   GPX5|<game_slug>|<variant>|<player>|<score>|<continues>|<powerups>|<seed_b58>|<duration>|<move_hash_b58>[|<meta>]
    ///
    /// Fairness rule: `continues` and `powerups` must be visibly surfaced on
    /// any leaderboard UI. The arcade-precedent guardrail (1980s 1CC culture)
    /// is that no-continue runs are the "pure" board.
    pub fn submit_score(
        ctx: Context<SubmitScore>,
        variant: String,
        score: u64,
        continues_used: u8,
        powerups_used: u8,
        session_seed: [u8; 32],
        duration_sec: u32,
        move_hash: [u8; 32],
        meta: String,
        // `vs_challenger`: pass Pubkey::default() for "no challenge context".
        // Any other pubkey is folded into GPX5 meta as `vs:<pubkey>`.
        // Display-only social proof; does NOT affect affiliate attribution,
        // which is fixed by profile.referrer at open_player_profile time.
        vs_challenger: Pubkey,
    ) -> Result<()> {
        require!(variant.len() <= MAX_VARIANT_LEN, ArcadeError::VariantTooLong);
        require!(meta.len() <= MAX_META_LEN, ArcadeError::MetaTooLong);
        require!(duration_sec > 0, ArcadeError::InvalidDuration);

        let game = &mut ctx.accounts.game;
        let profile = &mut ctx.accounts.profile;
        let cfg = &mut ctx.accounts.config;

        // Aggregate counters.
        game.total_sessions = game
            .total_sessions
            .checked_add(1)
            .ok_or(ArcadeError::Overflow)?;
        game.total_score_commits = game
            .total_score_commits
            .checked_add(1)
            .ok_or(ArcadeError::Overflow)?;
        profile.total_sessions = profile
            .total_sessions
            .checked_add(1)
            .ok_or(ArcadeError::Overflow)?;
        profile.total_score_commits = profile
            .total_score_commits
            .checked_add(1)
            .ok_or(ArcadeError::Overflow)?;
        cfg.total_score_commits = cfg
            .total_score_commits
            .checked_add(1)
            .ok_or(ArcadeError::Overflow)?;

        // Build GPX5 v2 memo string.
        let seed_b58 = bs58::encode(&session_seed).into_string();
        let hash_b58 = bs58::encode(&move_hash).into_string();
        let variant_str = if variant.is_empty() { "-".to_string() } else { variant.clone() };
        // Fold vs_challenger into meta if non-default — display-only attribution.
        let combined_meta = if vs_challenger != Pubkey::default() {
            if meta.is_empty() {
                format!("vs:{}", vs_challenger)
            } else {
                format!("{},vs:{}", meta, vs_challenger)
            }
        } else {
            meta.clone()
        };
        let memo = if combined_meta.is_empty() {
            format!(
                "GPX5|{}|{}|{}|{}|{}|{}|{}|{}|{}",
                game.slug,
                variant_str,
                ctx.accounts.player.key(),
                score,
                continues_used,
                powerups_used,
                seed_b58,
                duration_sec,
                hash_b58,
            )
        } else {
            format!(
                "GPX5|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}",
                game.slug,
                variant_str,
                ctx.accounts.player.key(),
                score,
                continues_used,
                powerups_used,
                seed_b58,
                duration_sec,
                hash_b58,
                combined_meta,
            )
        };
        require!(memo.len() <= MAX_MEMO_LEN, ArcadeError::MemoTooLong);

        // CPI to SPL Memo program — writes the memo into the tx log so anyone
        // can scan it later. No accounts required beyond the program itself.
        let ix = Instruction {
            program_id: SPL_MEMO_ID,
            accounts: vec![],
            data: memo.as_bytes().to_vec(),
        };
        invoke(&ix, &[ctx.accounts.memo_program.to_account_info()])?;

        emit!(ScoreSubmitted {
            game_id: game.game_id,
            player: ctx.accounts.player.key(),
            score,
            continues_used,
            powerups_used,
            duration_sec,
            season: cfg.current_season,
        });

        Ok(())
    }

    /// Record a payment made via Solana Pay / Flipcash, tied to a specific
    /// game action. Gives the player an auditable trail of what they paid for,
    /// and accrues affiliate earnings to the referrer if the tail is active.
    ///
    /// This does NOT execute the underlying payment — the USDC/$GAMER transfer
    /// already happened (player signed a Solana Pay tx before / atomically
    /// with this call). `record_payment` commits the tx sig + category +
    /// amount on-chain for audit and drives affiliate accrual.
    ///
    /// Amount bounds (defense against inflation / dust attacks):
    ///   MIN_PAYMENT_MICRO_USD  = $0.01   — blocks dust-spam farming
    ///   MAX_PAYMENT_MICRO_USD  = $100.00 — blocks inflated-claim attacks
    ///
    /// Affiliate payout logic:
    ///   - Only runs if profile.referrer is set and the tail window is open
    ///     (now < referrer_expires_at AND referrer_payments_remaining > 0)
    ///   - Computes 20% cut (AFFILIATE_CUT_BPS = 2000 basis points)
    ///   - Accrues to referrer_profile.affiliate_earned_accrued_micro
    ///   - Decrements referrer_payments_remaining
    ///   - Emits AffiliateAccrued event for off-chain indexers
    ///
    /// The referrer's PlayerProfile PDA must be passed if profile.referrer is
    /// set. If profile has no referrer, referrer_profile is ignored (None).
    pub fn record_payment(
        ctx: Context<RecordPayment>,
        // Category: 0 Continue | 1 Powerup | 2 ScoreCommit | 3 Cosmetic
        //         | 4 VerifiedCommit (requires external_ref = Arweave tx id)
        //         | 5 ReplayReceipt | 6 CnftWrap
        category: u8,
        // USD-equivalent value being paid (always in micro-USD, 6-decimal).
        // For stablecoins this equals payment_amount_raw. For SOL/$GAME the
        // frontend computes raw via the on-chain rate (and overpays slightly
        // for slippage) — contract validates raw ≥ floor.
        amount_micro_usd: u64,
        // Pubkey::default() = native SOL. Else the SPL mint of the transfer.
        // $GAME_TOKEN_MINT triggers the $GAME path (gamer_paid = true accrued).
        payment_mint: Pubkey,
        // Actual smallest-unit (lamports for SOL, token quarks for SPL).
        payment_amount_raw: u64,
        payment_tx_sig: [u8; 64],
        external_ref: String,
    ) -> Result<()> {
        require!(category <= CATEGORY_CNFT_WRAP, ArcadeError::InvalidPaymentCategory);
        require!(external_ref.len() <= MAX_EXTERNAL_REF_LEN, ArcadeError::ExternalRefTooLong);

        // Enforce exact Gamerplex fees for fixed-price tiers (USD-denominated).
        // Categories 0/1/3 (Continue/Powerup/Cosmetic) are client-priced per game.
        if category == CATEGORY_SCORE_COMMIT {
            require!(amount_micro_usd == SCORE_COMMIT_MICRO_USD, ArcadeError::InvalidScoreCommitAmount);
        } else if category == CATEGORY_VERIFIED_COMMIT {
            require!(amount_micro_usd == VERIFIED_COMMIT_MICRO_USD, ArcadeError::InvalidVerifiedAmount);
        } else if category == CATEGORY_REPLAY_RECEIPT {
            require!(amount_micro_usd == REPLAY_RECEIPT_MICRO_USD, ArcadeError::InvalidReplayReceiptAmount);
        } else if category == CATEGORY_CNFT_WRAP {
            require!(amount_micro_usd == CNFT_WRAP_MICRO_USD, ArcadeError::InvalidCnftWrapAmount);
        }
        require!(amount_micro_usd >= MIN_PAYMENT_MICRO_USD, ArcadeError::PaymentBelowMin);
        require!(amount_micro_usd <= MAX_PAYMENT_MICRO_USD, ArcadeError::PaymentAboveMax);

        let now = Clock::get()?.unix_timestamp;
        let game_id = ctx.accounts.game.game_id;
        let player_key = ctx.accounts.player.key();
        let treasury = ctx.accounts.config.treasury_wallet;
        let rates = &ctx.accounts.rates;
        let gamer_paid = payment_mint == GAME_TOKEN_MINT;

        // ── Branch on payment_mint ────────────────────────────────────
        if payment_mint == Pubkey::default() {
            // Native SOL path
            require!(
                now.saturating_sub(rates.sol_updated_at) <= MAX_RATE_STALENESS_SOL_SEC,
                ArcadeError::ExchangeRateStale
            );
            let expected = convert_usd_to_raw(amount_micro_usd, rates.sol_micro_usd_per_lamport)?;
            let min_lamports = apply_slippage_floor(expected, PAYMENT_SLIPPAGE_BPS)?;
            require!(payment_amount_raw >= min_lamports, ArcadeError::PaymentUnderpaid);
            verify_sol_transfer_in_tx(
                &ctx.accounts.instructions_sysvar.to_account_info(),
                &treasury,
                &player_key,
                payment_amount_raw,
            )?;
        } else if payment_mint == GAME_TOKEN_MINT {
            // $GAME path (20% discount already applied frontend-side to amount_micro_usd)
            require!(
                now.saturating_sub(rates.game_updated_at) <= MAX_RATE_STALENESS_GAME_SEC,
                ArcadeError::ExchangeRateStale
            );
            let expected = convert_usd_to_raw(amount_micro_usd, rates.game_micro_usd_per_quark)?;
            let min_quarks = apply_slippage_floor(expected, PAYMENT_SLIPPAGE_BPS)?;
            require!(payment_amount_raw >= min_quarks, ArcadeError::PaymentUnderpaid);
            verify_spl_transfer_for_mint_in_tx(
                &ctx.accounts.instructions_sysvar.to_account_info(),
                &GAME_TOKEN_MINT,
                GAME_TOKEN_DECIMALS,
                &treasury,
                &player_key,
                payment_amount_raw,
            )?;
        } else {
            // Stablecoin path — mint must be in the allowlist
            let mint_ok = ctx
                .accounts
                .stablecoin_config
                .mints
                .iter()
                .any(|m| *m == payment_mint && *m != Pubkey::default());
            require!(mint_ok, ArcadeError::PaymentMintNotAllowed);
            // Stablecoins are 6-decimal — raw amount IS the micro-USD value
            require!(
                amount_micro_usd == payment_amount_raw,
                ArcadeError::StablecoinAmountMismatch
            );
            verify_spl_transfer_for_mint_in_tx(
                &ctx.accounts.instructions_sysvar.to_account_info(),
                &payment_mint,
                STABLECOIN_DECIMALS,
                &treasury,
                &player_key,
                payment_amount_raw,
            )?;
        }

        // ── Profile aggregates (denominated in USD-equivalent) ─────────
        let profile = &mut ctx.accounts.profile;
        if gamer_paid {
            profile.total_spent_gamer_micro = profile
                .total_spent_gamer_micro
                .checked_add(amount_micro_usd)
                .ok_or(ArcadeError::Overflow)?;
        } else {
            // Stablecoins AND SOL accrue here as USD-equivalent. Off-chain
            // consumers disambiguate via PaymentRecorded.payment_mint.
            profile.total_spent_usdc_micro = profile
                .total_spent_usdc_micro
                .checked_add(amount_micro_usd)
                .ok_or(ArcadeError::Overflow)?;
        }

        emit!(PaymentRecorded {
            game_id,
            player: player_key,
            category,
            amount_micro_usd,
            payment_mint,
            payment_amount_raw,
            payment_tx_sig,
            external_ref: external_ref.clone(),
        });

        // ── Affiliate accrual ──────────────────────────────────────────
        let has_active_tail = profile.referrer != Pubkey::default()
            && now < profile.referrer_expires_at
            && profile.referrer_payments_remaining > 0;
        if has_active_tail {
            let referrer_profile = ctx
                .accounts
                .referrer_profile
                .as_mut()
                .ok_or(ArcadeError::ReferrerProfileRequired)?;
            require!(
                referrer_profile.wallet == profile.referrer,
                ArcadeError::ReferrerProfileMismatch
            );

            // 20% of USD-equivalent — same math regardless of payment mint
            let cut = amount_micro_usd
                .checked_mul(AFFILIATE_CUT_BPS)
                .ok_or(ArcadeError::Overflow)?
                .checked_div(10_000)
                .ok_or(ArcadeError::Overflow)?;

            referrer_profile.affiliate_earned_accrued_micro = referrer_profile
                .affiliate_earned_accrued_micro
                .checked_add(cut)
                .ok_or(ArcadeError::Overflow)?;
            referrer_profile.affiliate_earned_lifetime_micro = referrer_profile
                .affiliate_earned_lifetime_micro
                .checked_add(cut)
                .ok_or(ArcadeError::Overflow)?;

            // First-payment detection — sum across all payment mints
            // (USD-equiv + $GAME-equiv). True iff this payment is the very
            // first one and brings the sum exactly equal to amount_micro_usd.
            let total_spent_after = profile
                .total_spent_usdc_micro
                .checked_add(profile.total_spent_gamer_micro)
                .ok_or(ArcadeError::Overflow)?;
            if total_spent_after == amount_micro_usd {
                referrer_profile.affiliate_referred_payers = referrer_profile
                    .affiliate_referred_payers
                    .checked_add(1)
                    .ok_or(ArcadeError::Overflow)?;
            }

            profile.total_referred_payouts_micro = profile
                .total_referred_payouts_micro
                .checked_add(cut)
                .ok_or(ArcadeError::Overflow)?;
            profile.referrer_payments_remaining =
                profile.referrer_payments_remaining.saturating_sub(1);

            emit!(AffiliateAccrued {
                player: player_key,
                referrer: profile.referrer,
                game_id,
                cut_micro_usd: cut,
                gamer_paid,
                payments_remaining: profile.referrer_payments_remaining,
                expires_at: profile.referrer_expires_at,
            });
        }

        Ok(())
    }

    // ========================================================================
    // Admin ops (season rotation — can be called by the admin wallet only)
    // ========================================================================

    // ========================================================================
    // VERIFIED-tier session replay (v2)
    // ========================================================================

    /// Commit a full deterministic move log on-chain so anyone can replay the
    /// session and cryptographically verify the submitted score. Emits a
    /// GPX5R memo carrying the base64-encoded log. Triggers the 🏆 VERIFIED
    /// leaderboard badge.
    ///
    /// Pricing: player has already paid via a preceding `record_payment` with
    /// category=CATEGORY_VERIFIED_COMMIT and amount=VERIFIED_COMMIT_MICRO_USD
    /// ($0.10) in the same tx. We trust the frontend to bundle them; if the
    /// payment tx doesn't land the resolver flags the score + removes the
    /// VERIFIED badge. Economic deterrent is the $0.10 fee already paid.
    ///
    /// Size limit: 400 bytes of binary move-data (~540 chars base64). Games
    /// whose sessions routinely exceed this can instead use the
    /// `external_ref` field on record_payment pointing at an off-chain store
    /// (Arweave recommended).
    pub fn commit_session_replay(
        ctx: Context<CommitSessionReplay>,
        score_nonce: u64,
        session_seed: [u8; 32],
        move_log: Vec<u8>,
    ) -> Result<()> {
        require!(
            !move_log.is_empty(),
            ArcadeError::MoveLogEmpty
        );
        require!(
            move_log.len() <= MAX_MOVE_LOG_BYTES,
            ArcadeError::MoveLogTooLong
        );

        // Require a matching paid record_payment(VERIFIED_COMMIT) in the same
        // tx, and that this ix appears at most once.
        verify_unique_payment_pairing(
            &ctx.accounts.instructions_sysvar.to_account_info(),
            CATEGORY_VERIFIED_COMMIT,
            VERIFIED_COMMIT_MICRO_USD,
            crate::instruction::CommitSessionReplay::DISCRIMINATOR,
            crate::instruction::RecordPayment::DISCRIMINATOR,
            &ctx.accounts.player.key(),
        )?;

        // Base64-encode inline (tiny, no crate dep required).
        let log_b64 = base64_encode(&move_log);
        let seed_b58 = bs58::encode(&session_seed).into_string();

        let memo = format!(
            "GPX5R|{}|{}|{}|{}",
            ctx.accounts.player.key(),
            score_nonce,
            seed_b58,
            log_b64,
        );
        require!(
            memo.len() <= MAX_REPLAY_MEMO_LEN,
            ArcadeError::MemoTooLong
        );

        let ix = Instruction {
            program_id: SPL_MEMO_ID,
            accounts: vec![],
            data: memo.as_bytes().to_vec(),
        };
        invoke(&ix, &[ctx.accounts.memo_program.to_account_info()])?;

        emit!(SessionReplayCommitted {
            player: ctx.accounts.player.key(),
            score_nonce,
            move_log_bytes: move_log.len() as u16,
        });

        Ok(())
    }

    // ========================================================================
    // T3 — ReplayReceipt: user-owned, transferable run certificate
    // ========================================================================

    /// Mint a ReplayReceipt PDA for a completed run. Requires the player to
    /// have paid CATEGORY_REPLAY_RECEIPT ($0.25) via record_payment in the
    /// same tx. Stamps the run data immutably (original_player = signer,
    /// owner = signer initially — these CAN diverge later via transfer).
    ///
    /// The PDA is seeded by (player, nonce) so each receipt is unique. Client
    /// passes the nonce (typically the submit-score timestamp) to make
    /// receipts addressable.
    pub fn mint_replay_receipt(
        ctx: Context<MintReplayReceipt>,
        nonce: u64,
        score: u64,
        continues_used: u8,
        powerups_used: u8,
        session_seed: [u8; 32],
        move_hash: [u8; 32],
        duration_sec: u32,
        gpx5r_memo_tx: [u8; 64],
    ) -> Result<()> {
        require!(score > 0, ArcadeError::InvalidScore);
        require!(duration_sec > 0, ArcadeError::InvalidDuration);

        // Require a matching paid record_payment(REPLAY_RECEIPT) in the same
        // tx, and that this ix appears at most once.
        verify_unique_payment_pairing(
            &ctx.accounts.instructions_sysvar.to_account_info(),
            CATEGORY_REPLAY_RECEIPT,
            REPLAY_RECEIPT_MICRO_USD,
            crate::instruction::MintReplayReceipt::DISCRIMINATOR,
            crate::instruction::RecordPayment::DISCRIMINATOR,
            &ctx.accounts.player.key(),
        )?;

        let r = &mut ctx.accounts.receipt;
        let now = Clock::get()?.unix_timestamp;
        let player_key = ctx.accounts.player.key();

        // Immutable attribution
        r.original_player = player_key;
        r.game_id = ctx.accounts.game.game_id;
        r.score = score;
        r.continues_used = continues_used;
        r.powerups_used = powerups_used;
        r.session_seed = session_seed;
        r.move_hash = move_hash;
        r.duration_sec = duration_sec;
        r.gpx5r_memo_tx = gpx5r_memo_tx;
        r.minted_at = now;
        r.season = ctx.accounts.config.current_season;
        r.nonce = nonce;

        // Transferable ownership (starts = original_player)
        r.owner = player_key;

        // Not yet wrapped as cNFT
        r.cnft_wrapped = false;
        r.cnft_asset_id = Pubkey::default();

        r.bump = ctx.bumps.receipt;

        emit!(ReplayReceiptMinted {
            original_player: r.original_player,
            owner: r.owner,
            game_id: r.game_id,
            score: r.score,
            nonce: r.nonce,
            gpx5r_memo_tx: r.gpx5r_memo_tx,
        });
        Ok(())
    }

    /// Transfer ReplayReceipt ownership. Only the current owner can call.
    /// `original_player` is IMMUTABLE — never touched here. The transfer
    /// only moves the tradeable right, never the creator attribution.
    pub fn transfer_replay_receipt(
        ctx: Context<TransferReplayReceipt>,
        new_owner: Pubkey,
    ) -> Result<()> {
        require!(new_owner != Pubkey::default(), ArcadeError::InvalidNewOwner);
        let r = &mut ctx.accounts.receipt;
        let prev_owner = r.owner;
        r.owner = new_owner;
        emit!(ReplayReceiptTransferred {
            original_player: r.original_player, // unchanged — logged for convenience
            prev_owner,
            new_owner,
            nonce: r.nonce,
            game_id: r.game_id,
        });
        Ok(())
    }

    /// Close ReplayReceipt and refund rent to the current owner. Only owner
    /// can call. If wrapped as cNFT, block close — the cNFT must be burned
    /// / unwrapped first (kept as invariant for v1.3 integration).
    pub fn close_replay_receipt(ctx: Context<CloseReplayReceipt>) -> Result<()> {
        let r = &ctx.accounts.receipt;
        require!(!r.cnft_wrapped, ArcadeError::ReceiptWrappedAsCnft);
        emit!(ReplayReceiptClosed {
            original_player: r.original_player,
            owner: r.owner,
            nonce: r.nonce,
            game_id: r.game_id,
        });
        // Rent refund happens automatically via Anchor's `close = owner_wallet`.
        Ok(())
    }

    pub fn rotate_season(ctx: Context<RotateSeason>, deadline: i64) -> Result<()> {
        check_deadline(deadline)?;
        let cfg = &mut ctx.accounts.config;
        cfg.current_season = cfg
            .current_season
            .checked_add(1)
            .ok_or(ArcadeError::Overflow)?;
        emit!(SeasonRotated {
            new_season: cfg.current_season,
        });
        Ok(())
    }

    // ========================================================================
    // Stablecoin allowlist (admin-only, deadline-gated)
    // ========================================================================

    /// One-time init of the StablecoinConfig PDA. Admin passes the initial
    /// allowlist of accepted stablecoin mints. Up to MAX_STABLECOIN_SLOTS = 8
    /// slots; unused slots set to `Pubkey::default()`.
    ///
    /// Typical bootstrap:
    ///   Devnet:  [USDC_DEVNET,  default, default, ...]
    ///   Mainnet: [USDC_MAINNET, default, default, ...]
    /// Additional stablecoins added later via update_accepted_stablecoins.
    pub fn initialize_stablecoins(
        ctx: Context<InitializeStablecoins>,
        mints: [Pubkey; MAX_STABLECOIN_SLOTS],
    ) -> Result<()> {
        let sc = &mut ctx.accounts.stablecoin_config;
        sc.admin = ctx.accounts.admin.key();
        sc.mints = mints;
        sc.bump = ctx.bumps.stablecoin_config;
        emit!(StablecoinsInitialized { mints });
        Ok(())
    }

    /// Update the accepted stablecoin allowlist. Admin-only, deadline-gated.
    /// Overwrite semantics — pass the full desired array each time.
    pub fn update_accepted_stablecoins(
        ctx: Context<UpdateAcceptedStablecoins>,
        mints: [Pubkey; MAX_STABLECOIN_SLOTS],
        deadline: i64,
    ) -> Result<()> {
        check_deadline(deadline)?;
        let sc = &mut ctx.accounts.stablecoin_config;
        sc.mints = mints;
        emit!(StablecoinsUpdated { mints });
        Ok(())
    }

    // ========================================================================
    // Exchange rates (v1.3 — admin-pushed for SOL + $GAME pricing)
    // ========================================================================

    /// One-time init of ExchangeRatesConfig PDA. Both rates required, scaled
    /// ×RATE_SCALE_FACTOR (1e12). Admin-only.
    pub fn initialize_exchange_rates(
        ctx: Context<InitializeExchangeRates>,
        sol_micro_usd_per_lamport: u64,
        game_micro_usd_per_quark: u64,
    ) -> Result<()> {
        require!(sol_micro_usd_per_lamport > 0, ArcadeError::ExchangeRateStale);
        require!(game_micro_usd_per_quark > 0, ArcadeError::ExchangeRateStale);
        let now = Clock::get()?.unix_timestamp;
        let r = &mut ctx.accounts.rates;
        r.admin = ctx.accounts.admin.key();
        r.sol_micro_usd_per_lamport = sol_micro_usd_per_lamport;
        r.game_micro_usd_per_quark = game_micro_usd_per_quark;
        r.sol_updated_at = now;
        r.game_updated_at = now;
        r.bump = ctx.bumps.rates;
        emit!(ExchangeRatesInitialized {
            sol_micro_usd_per_lamport,
            game_micro_usd_per_quark,
            updated_at: now,
        });
        Ok(())
    }

    /// Update exchange rates. Admin-only, deadline-gated. Pass 0 for either
    /// rate to leave it unchanged (no `updated_at` touch on the unchanged side).
    pub fn update_exchange_rates(
        ctx: Context<UpdateExchangeRates>,
        sol_micro_usd_per_lamport: u64,
        game_micro_usd_per_quark: u64,
        deadline: i64,
    ) -> Result<()> {
        check_deadline(deadline)?;
        let now = Clock::get()?.unix_timestamp;
        let r = &mut ctx.accounts.rates;
        let sol_updated = sol_micro_usd_per_lamport > 0;
        let game_updated = game_micro_usd_per_quark > 0;
        require!(sol_updated || game_updated, ArcadeError::ExchangeRateStale);
        if sol_updated {
            r.sol_micro_usd_per_lamport = sol_micro_usd_per_lamport;
            r.sol_updated_at = now;
        }
        if game_updated {
            r.game_micro_usd_per_quark = game_micro_usd_per_quark;
            r.game_updated_at = now;
        }
        emit!(ExchangeRatesUpdated {
            sol_micro_usd_per_lamport: r.sol_micro_usd_per_lamport,
            game_micro_usd_per_quark: r.game_micro_usd_per_quark,
            sol_updated,
            game_updated,
            updated_at: now,
        });
        Ok(())
    }

    // ========================================================================
    // Identity — handle + bio (ProfileExtV2 sibling PDA)
    // ========================================================================

    /// Claim or rename a handle. First call also creates the caller's
    /// ProfileExtV2 PDA (init_if_needed). Atomic close-old + init-new claim.
    ///
    /// Caller responsibilities:
    ///   * Pass `old_handle_claim = null` on first claim.
    ///   * Pass the existing HandleClaim PDA on rename.
    ///   * Handle must match `[a-z0-9_]{3,32}` and not be in RESERVED_HANDLES.
    pub fn set_handle(ctx: Context<SetHandle>, handle: String) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let player_key = ctx.accounts.player.key();

        validate_handle(&handle)?;

        let ext = &mut ctx.accounts.profile_ext;
        let fresh_init = ext.wallet == Pubkey::default();
        if fresh_init {
            ext.wallet = player_key;
            ext.profile_version = 2;
            ext.bio = String::new();
            ext.created_at = now;
            ext.bump = ctx.bumps.profile_ext;
            emit!(ProfileExtOpened {
                wallet: player_key,
                created_at: now,
            });
        }

        // Reject rename-to-same — same PDA can't be closed and re-init'd in one tx.
        require!(ext.handle != handle, ArcadeError::HandleUnchanged);

        // If wallet already has a handle, the caller MUST pass the existing
        // claim so it's closed for rent refund. (Anchor's `close = player`
        // does the work; we only enforce the requirement here.)
        if !ext.handle.is_empty() {
            require!(
                ctx.accounts.old_handle_claim.is_some(),
                ArcadeError::OldHandleClaimRequired
            );
        }
        // Conversely, on fresh / no-existing-handle, passing an old claim is
        // a logic error in the client — reject to avoid closing a stray PDA.
        if ext.handle.is_empty() {
            require!(
                ctx.accounts.old_handle_claim.is_none(),
                ArcadeError::OldHandleClaimUnexpected
            );
        }

        // Initialize the new claim. Account-level `init` constraint already
        // enforced global uniqueness; this just fills the body.
        let claim = &mut ctx.accounts.new_handle_claim;
        claim.wallet = player_key;
        claim.claimed_at = now;
        claim.bump = ctx.bumps.new_handle_claim;

        emit!(HandleSet {
            wallet: player_key,
            old_handle: ext.handle.clone(),
            new_handle: handle.clone(),
            set_at: now,
        });

        ext.handle = handle;
        Ok(())
    }

    /// Set or update bio. First call also creates the caller's ProfileExtV2
    /// PDA. Empty string allowed (clears the bio).
    pub fn update_bio(ctx: Context<UpdateBio>, bio: String) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let player_key = ctx.accounts.player.key();

        require!(bio.len() <= MAX_BIO_LEN, ArcadeError::BioTooLong);
        validate_bio(&bio)?;

        let ext = &mut ctx.accounts.profile_ext;
        if ext.wallet == Pubkey::default() {
            ext.wallet = player_key;
            ext.profile_version = 2;
            ext.handle = String::new();
            ext.created_at = now;
            ext.bump = ctx.bumps.profile_ext;
            emit!(ProfileExtOpened {
                wallet: player_key,
                created_at: now,
            });
        }

        let bio_len = bio.len() as u16;
        ext.bio = bio;
        emit!(BioUpdated {
            wallet: player_key,
            bio_len,
            updated_at: now,
        });
        Ok(())
    }
}

// ============================================================================
// State
// ============================================================================

#[account]
pub struct ArcadeConfig {
    pub admin: Pubkey,
    pub treasury_wallet: Pubkey,
    pub current_season: u16,
    pub next_game_id: u8,
    pub total_games_registered: u32,
    pub total_score_commits: u64,
    pub total_profiles_opened: u64,
    pub bump: u8,
}

impl ArcadeConfig {
    // 8 (disc) + 32 + 32 + 2 + 1 + 4 + 8 + 8 + 1
    pub const SPACE: usize = 8 + 32 + 32 + 2 + 1 + 4 + 8 + 8 + 1;
}

/// Allowlist of stablecoin mints accepted for arcade payments. Stored in a
/// separate PDA (not ArcadeConfig) so the existing config's rent / layout is
/// undisturbed — avoids a painful realloc migration on the already-deployed
/// devnet account.
///
/// Initialised once by the admin via `initialize_stablecoins`, updated via
/// `update_accepted_stablecoins` (deadline-gated). Empty slots = `Pubkey::default()`.
#[account]
pub struct StablecoinConfig {
    pub admin: Pubkey,                              // mirrored from ArcadeConfig at init
    pub mints: [Pubkey; MAX_STABLECOIN_SLOTS],
    pub bump: u8,
}

impl StablecoinConfig {
    // 8 (disc) + 32 admin + 32*8 mints + 1 bump
    pub const SPACE: usize = 8 + 32 + 32 * MAX_STABLECOIN_SLOTS + 1;
}

/// Off-chain-pushed exchange rates for SOL and $GAME denominated in USD.
/// Separate PDA so ArcadeConfig's rent / layout stay undisturbed (same pattern
/// as StablecoinConfig). Updated by the admin (typically a bot signing every
/// 15min) via `update_exchange_rates`.
///
/// Rates are stored ×1e12 micro-USD per smallest unit (lamport / quark) for
/// fixed-point precision. Example at SOL=$150:
///   sol_micro_usd_per_lamport = 150_000_000_000  (= 0.15 micro-USD/lamport × 1e12)
#[account]
pub struct ExchangeRatesConfig {
    pub admin: Pubkey,                  // mirror of ArcadeConfig.admin at init
    pub sol_micro_usd_per_lamport: u64, // scaled ×RATE_SCALE_FACTOR
    pub game_micro_usd_per_quark: u64,  // scaled ×RATE_SCALE_FACTOR
    pub sol_updated_at: i64,
    pub game_updated_at: i64,
    pub bump: u8,
}

impl ExchangeRatesConfig {
    // 8 disc + 32 admin + 8 + 8 + 8 + 8 + 1 = 73
    pub const SPACE: usize = 8 + 32 + 8 + 8 + 8 + 8 + 1;
}

#[account]
pub struct Game {
    pub game_id: u8,
    pub slug: String,          // max MAX_GAME_SLUG_LEN
    pub display_name: String,  // max MAX_GAME_NAME_LEN
    pub total_sessions: u64,
    pub total_score_commits: u64,
    pub created_at: i64,
    pub bump: u8,
}

impl Game {
    // 8 (disc) + 1 + (4 + 16 slug) + (4 + 32 name) + 8 + 8 + 8 + 1
    pub const SPACE: usize = 8 + 1 + 4 + MAX_GAME_SLUG_LEN + 4 + MAX_GAME_NAME_LEN + 8 + 8 + 8 + 1;
}

#[account]
pub struct PlayerProfile {
    pub wallet: Pubkey,
    pub total_sessions: u64,
    pub total_score_commits: u64,
    pub total_spent_usdc_micro: u64,
    pub total_spent_gamer_micro: u64,
    pub total_gamer_earned: u64,
    pub favorite_game_id: u8,
    pub vip_stake_amount: u64,
    pub cosmetics_owned: [u32; COSMETIC_BITMAP_WORDS],
    pub avatar_source: u8,
    pub nft_pfp_mint: Pubkey,
    pub cosmetic_avatar_id: u16,
    pub created_at: i64,
    // ── Affiliate attribution (immutable after profile open) ──
    /// Who referred this player via a challenge link. Pubkey::default() if
    /// none. Set once at open_player_profile; NEVER changed afterward.
    pub referrer: Pubkey,
    /// Unix seconds when the affiliate tail window expires.
    pub referrer_expires_at: i64,
    /// How many more payments still accrue to the referrer (decrements).
    pub referrer_payments_remaining: u8,
    /// Cumulative micro-USD this player has generated as affiliate payouts
    /// to the referrer (lifetime, monotonic, audit trail).
    pub total_referred_payouts_micro: u64,
    // ── Earnings side (this profile AS referrer, collecting from others) ──
    /// Accrued but unclaimed affiliate earnings (in micro-USD). Grows with
    /// every referred player's payment while their tail is active. Unclaimed
    /// until Phase 2 `claim_affiliate_payout` ships; can be audited via
    /// AffiliateAccrued events in the meantime.
    pub affiliate_earned_accrued_micro: u64,
    /// Lifetime total earned via affiliate (for display + audit).
    pub affiliate_earned_lifetime_micro: u64,
    /// Count of distinct referred players who've ever paid something.
    pub affiliate_referred_payers: u32,
    pub bump: u8,
}

impl PlayerProfile {
    // Original: 8 disc + 32 wallet + 5×8 counters + 1 fav + 8 vip + 4×16 bitmap
    //         + 1 avatar + 32 mint + 2 cos_id + 8 created + 1 bump = 195
    // Added: 32 referrer + 8 expires + 1 payments_remaining + 8 total_refd
    //      + 8 accrued + 8 lifetime + 4 referred_payers = 69
    // Total = 264. Minor rent bump (~0.0019 SOL per profile). Worth it.
    pub const SPACE: usize =
        8 + 32 + 8 * 5 + 1 + 8 + 4 * COSMETIC_BITMAP_WORDS + 1 + 32 + 2 + 8
        + 32 + 8 + 1 + 8  // referrer attribution
        + 8 + 8 + 4       // earnings as referrer
        + 1;              // bump
}

/// Identity-layer extension PDA. Holds handle + bio + version. Created lazily
/// on first `set_handle` / `update_bio` via `init_if_needed`. Sibling of the
/// PlayerProfile PDA — matches the StablecoinConfig pattern above. Keeps the
/// existing PlayerProfile layout / rent / live devnet accounts undisturbed,
/// and lets non-gameplay surfaces (Sledgit identity-only users) have a handle
/// without opening a PlayerProfile.
///
/// Seeds: [PROFILE_EXT_SEED, wallet.as_ref()]
#[account]
pub struct ProfileExtV2 {
    /// Mirrors the seed. Set once on fresh init; never modified.
    pub wallet: Pubkey,
    /// Schema version (currently 2).
    pub profile_version: u8,
    /// User-chosen handle. Charset [a-z0-9_], 3-32 bytes. Empty until first
    /// set_handle. Backed by a HandleClaim PDA at [HANDLE_CLAIM_SEED, handle].
    pub handle: String,
    /// Free-form bio. Max 140 UTF-8 bytes. Empty until first update_bio.
    pub bio: String,
    /// Unix seconds when this ext was created. Immutable after fresh init.
    pub created_at: i64,
    pub bump: u8,
}

impl ProfileExtV2 {
    // 8 disc + 32 wallet + 1 ver + (4 + MAX_HANDLE_LEN) handle
    //   + (4 + MAX_BIO_LEN) bio + 8 created + 1 bump
    pub const SPACE: usize =
        8 + 32 + 1 + 4 + MAX_HANDLE_LEN + 4 + MAX_BIO_LEN + 8 + 1;
}

/// Global uniqueness ledger for handles. Existence at
/// [HANDLE_CLAIM_SEED, handle.as_bytes()] IS the claim. Closed and re-init'd
/// on handle change so the rent is recovered.
#[account]
pub struct HandleClaim {
    /// The wallet whose ProfileExtV2 currently owns this handle.
    pub wallet: Pubkey,
    /// Unix seconds when claim was created.
    pub claimed_at: i64,
    pub bump: u8,
}

impl HandleClaim {
    // 8 disc + 32 wallet + 8 claimed_at + 1 bump = 49
    pub const SPACE: usize = 8 + 32 + 8 + 1;
}

/// ReplayReceipt — user-owned, transferable certificate of a completed run.
///
/// Key invariants (baked into the program — not mutable by any instruction):
///   - `original_player` is stamped at mint time and NEVER modified.
///     Even if the receipt is sold or transferred, the original player
///     attribution stays in history forever (same model as NBA Top Shot,
///     CryptoPunks: creator is immutable, owner is transferable).
///   - `owner` starts equal to `original_player` and can only be changed
///     via the explicit `transfer_replay_receipt` instruction, which
///     requires the current owner's signature.
///   - Leaderboards ALWAYS key on `original_player`, never on `owner`.
///     This prevents pay-to-win on leaderboards via receipt purchases.
///
/// The canonical replay data (move log) lives permanently as a GPX5R memo
/// in Solana tx history; this PDA is a transferable pointer to it.
#[account]
pub struct ReplayReceipt {
    // ── Immutable attribution (stamped at mint, never modified) ──
    pub original_player: Pubkey,        // who actually played the run
    pub game_id: u8,
    pub score: u64,
    pub continues_used: u8,
    pub powerups_used: u8,
    pub session_seed: [u8; 32],
    pub move_hash: [u8; 32],
    pub duration_sec: u32,
    pub gpx5r_memo_tx: [u8; 64],        // pointer to canonical replay memo in tx history
    pub minted_at: i64,
    pub season: u16,
    pub nonce: u64,                     // per-player unique id (e.g. submit_timestamp)

    // ── Transferable ownership ──
    pub owner: Pubkey,                  // current holder; updated on transfer

    // ── cNFT wrap state (T4, set when CATEGORY_CNFT_WRAP paid) ──
    pub cnft_wrapped: bool,
    pub cnft_asset_id: Pubkey,          // Pubkey::default() until wrapped

    pub bump: u8,
}

impl ReplayReceipt {
    // 8 disc + 32 original + 1 game_id + 8 score + 1 cont + 1 pu + 32 seed
    //   + 32 hash + 4 dur + 64 gpx5r_tx + 8 minted + 2 season + 8 nonce
    //   + 32 owner + 1 wrapped + 32 cnft_asset + 1 bump = 267
    pub const SPACE: usize =
        8 + 32 + 1 + 8 + 1 + 1 + 32 + 32 + 4 + 64 + 8 + 2 + 8
        + 32 + 1 + 32 + 1;
}

// ============================================================================
// Accounts
// ============================================================================

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(
        init,
        payer = admin,
        space = ArcadeConfig::SPACE,
        seeds = [CONFIG_SEED],
        bump
    )]
    pub config: Account<'info, ArcadeConfig>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(game_id: u8)]
pub struct RegisterGame<'info> {
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = admin @ ArcadeError::AdminOnly,
    )]
    pub config: Account<'info, ArcadeConfig>,
    #[account(
        init,
        payer = admin,
        space = Game::SPACE,
        seeds = [GAME_SEED, &[game_id]],
        bump
    )]
    pub game: Account<'info, Game>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct OpenPlayerProfile<'info> {
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
    )]
    pub config: Account<'info, ArcadeConfig>,
    #[account(
        init,
        payer = player,
        space = PlayerProfile::SPACE,
        seeds = [PROFILE_SEED, player.key().as_ref()],
        bump
    )]
    pub profile: Account<'info, PlayerProfile>,
    /// Optional: if a referrer is passed in the instruction, the referrer's
    /// already-open PlayerProfile must be provided here. The PDA seeds
    /// constraint + `wallet` field check in the instruction guarantees the
    /// referrer actually exists on Gamerplex — blocks arbitrary-wallet spoof.
    /// When no referrer is passed, this account is ignored (None).
    pub referrer_profile: Option<Account<'info, PlayerProfile>>,
    #[account(mut)]
    pub player: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateAvatar<'info> {
    #[account(
        mut,
        seeds = [PROFILE_SEED, player.key().as_ref()],
        bump = profile.bump,
        has_one = wallet @ ArcadeError::ProfileOwnerMismatch,
        constraint = profile.wallet == player.key() @ ArcadeError::ProfileOwnerMismatch,
    )]
    pub profile: Account<'info, PlayerProfile>,
    /// CHECK: the profile's owner — address-constrained above.
    pub wallet: AccountInfo<'info>,
    pub player: Signer<'info>,
}

#[derive(Accounts)]
pub struct SubmitScore<'info> {
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
    )]
    pub config: Account<'info, ArcadeConfig>,
    #[account(
        mut,
        seeds = [GAME_SEED, &[game.game_id]],
        bump = game.bump,
    )]
    pub game: Account<'info, Game>,
    #[account(
        mut,
        seeds = [PROFILE_SEED, player.key().as_ref()],
        bump = profile.bump,
        has_one = wallet @ ArcadeError::ProfileOwnerMismatch,
    )]
    pub profile: Account<'info, PlayerProfile>,
    /// CHECK: the profile's owner — address-constrained above.
    pub wallet: AccountInfo<'info>,
    pub player: Signer<'info>,
    /// CHECK: the SPL Memo program — we CPI into it with the GPX5 string.
    #[account(address = SPL_MEMO_ID)]
    pub memo_program: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct RecordPayment<'info> {
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
    )]
    pub config: Account<'info, ArcadeConfig>,
    #[account(
        seeds = [STABLECOINS_SEED],
        bump = stablecoin_config.bump,
    )]
    pub stablecoin_config: Account<'info, StablecoinConfig>,
    #[account(
        seeds = [GAME_SEED, &[game.game_id]],
        bump = game.bump,
    )]
    pub game: Account<'info, Game>,
    #[account(
        mut,
        seeds = [PROFILE_SEED, player.key().as_ref()],
        bump = profile.bump,
        has_one = wallet @ ArcadeError::ProfileOwnerMismatch,
    )]
    pub profile: Account<'info, PlayerProfile>,
    /// CHECK: the profile's owner — address-constrained above.
    pub wallet: AccountInfo<'info>,
    /// Referrer's PlayerProfile — required if profile.referrer is set and
    /// the tail window is active. Seeds constrain it to the expected wallet
    /// (no mismatched profile can be passed). Optional because many players
    /// have no referrer and the instruction skips affiliate logic in that
    /// case.
    #[account(
        mut,
        seeds = [PROFILE_SEED, profile.referrer.as_ref()],
        bump = referrer_profile.bump,
    )]
    pub referrer_profile: Option<Account<'info, PlayerProfile>>,
    /// Read-only exchange rates PDA (v1.3+). Required for SOL / $GAME paths;
    /// always-passed for ix-layout simplicity. Stablecoin paths ignore it.
    #[account(
        seeds = [RATES_SEED],
        bump = rates.bump,
    )]
    pub rates: Account<'info, ExchangeRatesConfig>,
    pub player: Signer<'info>,
    /// CHECK: Instructions sysvar — read-only, introspected for the matching
    /// SPL TransferChecked. Address-constrained to the canonical sysvar id.
    #[account(address = ix_sysvar::ID)]
    pub instructions_sysvar: UncheckedAccount<'info>,
}

#[derive(Accounts)]
#[instruction(nonce: u64)]
pub struct MintReplayReceipt<'info> {
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
    )]
    pub config: Account<'info, ArcadeConfig>,
    #[account(
        seeds = [GAME_SEED, &[game.game_id]],
        bump = game.bump,
    )]
    pub game: Account<'info, Game>,
    #[account(
        init,
        payer = player,
        space = ReplayReceipt::SPACE,
        seeds = [RECEIPT_SEED, player.key().as_ref(), &nonce.to_le_bytes()],
        bump,
    )]
    pub receipt: Account<'info, ReplayReceipt>,
    #[account(mut)]
    pub player: Signer<'info>,
    pub system_program: Program<'info, System>,
    /// CHECK: Instructions sysvar — read-only, introspected for the matching
    /// record_payment(REPLAY_RECEIPT).
    #[account(address = ix_sysvar::ID)]
    pub instructions_sysvar: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct TransferReplayReceipt<'info> {
    /// Receipt to transfer — Anchor validates program-ownership + discriminator
    /// via the account type. has_one enforces receipt.owner == signer.
    #[account(
        mut,
        has_one = owner @ ArcadeError::NotReceiptOwner,
    )]
    pub receipt: Account<'info, ReplayReceipt>,
    pub owner: Signer<'info>,
}

#[derive(Accounts)]
pub struct CloseReplayReceipt<'info> {
    /// Receipt to close — rent refunded to owner's wallet. Close requires owner sig.
    /// If wrapped as cNFT, the instruction body blocks close until unwrapped.
    #[account(
        mut,
        close = owner,
        has_one = owner @ ArcadeError::NotReceiptOwner,
    )]
    pub receipt: Account<'info, ReplayReceipt>,
    /// Current owner (signs + receives refunded rent).
    #[account(mut)]
    pub owner: Signer<'info>,
}

#[derive(Accounts)]
pub struct CommitSessionReplay<'info> {
    pub player: Signer<'info>,
    /// CHECK: SPL Memo program, we CPI into it with the GPX5R string.
    #[account(address = SPL_MEMO_ID)]
    pub memo_program: AccountInfo<'info>,
    /// CHECK: Instructions sysvar — read-only, introspected for the matching
    /// record_payment(VERIFIED_COMMIT).
    #[account(address = ix_sysvar::ID)]
    pub instructions_sysvar: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct RotateSeason<'info> {
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = admin @ ArcadeError::AdminOnly,
    )]
    pub config: Account<'info, ArcadeConfig>,
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct InitializeStablecoins<'info> {
    /// Admin must match ArcadeConfig.admin. has_one enforces this.
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = admin @ ArcadeError::AdminOnly,
    )]
    pub config: Account<'info, ArcadeConfig>,
    #[account(
        init,
        payer = admin,
        space = StablecoinConfig::SPACE,
        seeds = [STABLECOINS_SEED],
        bump,
    )]
    pub stablecoin_config: Account<'info, StablecoinConfig>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateAcceptedStablecoins<'info> {
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = admin @ ArcadeError::AdminOnly,
    )]
    pub config: Account<'info, ArcadeConfig>,
    #[account(
        mut,
        seeds = [STABLECOINS_SEED],
        bump = stablecoin_config.bump,
    )]
    pub stablecoin_config: Account<'info, StablecoinConfig>,
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct InitializeExchangeRates<'info> {
    /// Admin must match ArcadeConfig.admin.
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = admin @ ArcadeError::AdminOnly,
    )]
    pub config: Account<'info, ArcadeConfig>,
    #[account(
        init,
        payer = admin,
        space = ExchangeRatesConfig::SPACE,
        seeds = [RATES_SEED],
        bump,
    )]
    pub rates: Account<'info, ExchangeRatesConfig>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateExchangeRates<'info> {
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = admin @ ArcadeError::AdminOnly,
    )]
    pub config: Account<'info, ArcadeConfig>,
    #[account(
        mut,
        seeds = [RATES_SEED],
        bump = rates.bump,
    )]
    pub rates: Account<'info, ExchangeRatesConfig>,
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(handle: String)]
pub struct SetHandle<'info> {
    /// Created on first call (init_if_needed); mutated on rename.
    /// Seeds bind it to the signer's wallet — no other wallet can ever write here.
    #[account(
        init_if_needed,
        payer = player,
        space = ProfileExtV2::SPACE,
        seeds = [PROFILE_EXT_SEED, player.key().as_ref()],
        bump,
    )]
    pub profile_ext: Account<'info, ProfileExtV2>,

    /// Existing claim for the wallet's current handle. REQUIRED if
    /// `profile_ext.handle != ""` (rename). Pass `null` on the first claim.
    /// Closed at end of ix → rent refunded to player.
    #[account(
        mut,
        close = player,
        seeds = [HANDLE_CLAIM_SEED, profile_ext.handle.as_bytes()],
        bump = old_handle_claim.bump,
        constraint = old_handle_claim.wallet == player.key() @ ArcadeError::HandleClaimMismatch,
    )]
    pub old_handle_claim: Option<Account<'info, HandleClaim>>,

    /// New claim being created. Init constraint enforces global uniqueness —
    /// if anyone else already owns this handle, init fails with account-exists.
    #[account(
        init,
        payer = player,
        space = HandleClaim::SPACE,
        seeds = [HANDLE_CLAIM_SEED, handle.as_bytes()],
        bump,
    )]
    pub new_handle_claim: Account<'info, HandleClaim>,

    #[account(mut)]
    pub player: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateBio<'info> {
    /// Created on first call (init_if_needed); mutated on subsequent calls.
    #[account(
        init_if_needed,
        payer = player,
        space = ProfileExtV2::SPACE,
        seeds = [PROFILE_EXT_SEED, player.key().as_ref()],
        bump,
    )]
    pub profile_ext: Account<'info, ProfileExtV2>,

    #[account(mut)]
    pub player: Signer<'info>,
    pub system_program: Program<'info, System>,
}

// ============================================================================
// Events
// ============================================================================

#[event]
pub struct ConfigInitialized {
    pub admin: Pubkey,
    pub treasury_wallet: Pubkey,
}

#[event]
pub struct GameRegistered {
    pub game_id: u8,
    pub slug: String,
    pub display_name: String,
}

#[event]
pub struct ProfileOpened {
    pub wallet: Pubkey,
    pub created_at: i64,
    pub referrer: Pubkey,
}

#[event]
pub struct AffiliateAttributed {
    pub player: Pubkey,
    pub referrer: Pubkey,
    pub expires_at: i64,
    pub payments_allotted: u8,
}

#[event]
pub struct AffiliateAccrued {
    pub player: Pubkey,
    pub referrer: Pubkey,
    pub game_id: u8,
    pub cut_micro_usd: u64,
    pub gamer_paid: bool,
    pub payments_remaining: u8,
    pub expires_at: i64,
}

#[event]
pub struct ScoreSubmitted {
    pub game_id: u8,
    pub player: Pubkey,
    pub score: u64,
    pub continues_used: u8,
    pub powerups_used: u8,
    pub duration_sec: u32,
    pub season: u16,
}

#[event]
pub struct PaymentRecorded {
    pub game_id: u8,
    pub player: Pubkey,
    pub category: u8,
    pub amount_micro_usd: u64,        // USD-equivalent value claimed
    pub payment_mint: Pubkey,         // Pubkey::default() = SOL native, else SPL mint
    pub payment_amount_raw: u64,      // actual lamports or token quarks transferred
    pub payment_tx_sig: [u8; 64],
    pub external_ref: String,
}

#[event]
pub struct SeasonRotated {
    pub new_season: u16,
}

#[event]
pub struct SessionReplayCommitted {
    pub player: Pubkey,
    pub score_nonce: u64,
    pub move_log_bytes: u16,
}

#[event]
pub struct ReplayReceiptMinted {
    pub original_player: Pubkey,
    pub owner: Pubkey,
    pub game_id: u8,
    pub score: u64,
    pub nonce: u64,
    pub gpx5r_memo_tx: [u8; 64],
}

#[event]
pub struct ReplayReceiptTransferred {
    pub original_player: Pubkey, // unchanged; logged for indexers
    pub prev_owner: Pubkey,
    pub new_owner: Pubkey,
    pub nonce: u64,
    pub game_id: u8,
}

#[event]
pub struct ReplayReceiptClosed {
    pub original_player: Pubkey,
    pub owner: Pubkey,
    pub nonce: u64,
    pub game_id: u8,
}

#[event]
pub struct StablecoinsInitialized {
    pub mints: [Pubkey; MAX_STABLECOIN_SLOTS],
}

#[event]
pub struct StablecoinsUpdated {
    pub mints: [Pubkey; MAX_STABLECOIN_SLOTS],
}

#[event]
pub struct ExchangeRatesInitialized {
    pub sol_micro_usd_per_lamport: u64,
    pub game_micro_usd_per_quark: u64,
    pub updated_at: i64,
}

#[event]
pub struct ExchangeRatesUpdated {
    pub sol_micro_usd_per_lamport: u64,
    pub game_micro_usd_per_quark: u64,
    pub sol_updated: bool,
    pub game_updated: bool,
    pub updated_at: i64,
}

#[event]
pub struct ProfileExtOpened {
    pub wallet: Pubkey,
    pub created_at: i64,
}

#[event]
pub struct HandleSet {
    pub wallet: Pubkey,
    pub old_handle: String,
    pub new_handle: String,
    pub set_at: i64,
}

#[event]
pub struct BioUpdated {
    pub wallet: Pubkey,
    pub bio_len: u16,
    pub updated_at: i64,
}

// ============================================================================
// Helpers
// ============================================================================

/// Derive the Associated Token Account address for `(wallet, mint)` using
/// the canonical ATA program + token program IDs. Avoids a dependency on
/// `spl-associated-token-account` for one PDA derivation.
fn derive_ata(wallet: &Pubkey, mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[
            wallet.as_ref(),
            SPL_TOKEN_PROGRAM_ID.as_ref(),
            mint.as_ref(),
        ],
        &SPL_ATA_PROGRAM_ID,
    )
    .0
}

/// Enforce an admin-instruction deadline. Rejects txs where `deadline` is in
/// the past OR more than MAX_DEADLINE_FUTURE_SEC in the future.
fn check_deadline(deadline: i64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require!(now <= deadline, ArcadeError::InstructionExpired);
    let max_future = now
        .checked_add(MAX_DEADLINE_FUTURE_SEC)
        .ok_or(ArcadeError::Overflow)?;
    require!(deadline <= max_future, ArcadeError::DeadlineTooFar);
    Ok(())
}

// `verify_stablecoin_transfer_in_tx` (v1.2 USDC-only) replaced in v1.3 by
// `verify_spl_transfer_for_mint_in_tx` (single-mint + decimals enforcement,
// reused for both stablecoins and $GAME). See below.

/// Require exactly one matching `record_payment` (category + amount) signed
/// by `player` in the current tx, AND require the current ix to appear at
/// most once in the tx. Used by commit_session_replay and mint_replay_receipt.
fn verify_unique_payment_pairing(
    instructions_sysvar: &AccountInfo,
    payment_category: u8,
    payment_amount: u64,
    current_ix_disc: &[u8],
    record_payment_disc: &[u8],
    player: &Pubkey,
) -> Result<()> {
    let mut payment_count = 0u16;
    let mut current_count = 0u16;
    let mut i: usize = 0;
    loop {
        let ix = match ix_sysvar::load_instruction_at_checked(i, instructions_sysvar) {
            Ok(ix) => ix,
            Err(_) => break,
        };
        i += 1;

        if ix.program_id != crate::ID {
            continue;
        }
        if ix.data.len() < 8 {
            continue;
        }
        let disc = &ix.data[0..8];

        if disc == current_ix_disc {
            current_count = current_count.saturating_add(1);
            continue;
        }
        if disc != record_payment_disc {
            continue;
        }
        // record_payment Anchor args layout (after 8-byte disc, v1.3):
        //   category: u8         (1 byte)
        //   amount_micro_usd: u64 (8 bytes LE)
        //   payment_mint: Pubkey (32 bytes)        — new in v1.3
        //   payment_amount_raw: u64 (8 bytes LE)   — new in v1.3
        //   payment_tx_sig: [u8;64] (64 bytes)
        //   external_ref: String (4-byte len prefix + bytes)
        // Only category + amount are checked here — later fields don't affect pairing.
        if ix.data.len() < 8 + 1 + 8 {
            continue;
        }
        let category = ix.data[8];
        let amount = u64::from_le_bytes(ix.data[9..17].try_into().unwrap());
        if category != payment_category || amount != payment_amount {
            continue;
        }
        // RecordPayment account layout (v1.3 — `rates` inserted before player):
        //   [0] config, [1] stablecoin_config, [2] game, [3] profile,
        //   [4] wallet, [5] referrer_profile (Option sentinel or account),
        //   [6] rates, [7] player (Signer), [8] instructions_sysvar
        if ix.accounts.len() < 8 {
            continue;
        }
        if ix.accounts[7].pubkey != *player {
            continue;
        }
        payment_count = payment_count.saturating_add(1);
    }
    require!(payment_count == 1, ArcadeError::RequiredPaymentMissing);
    require!(current_count == 1, ArcadeError::DuplicateIxInTx);
    Ok(())
}

// ── v1.3 multi-token payment helpers ────────────────────────────────────

/// Confirm the current tx contains an SPL Token `TransferChecked` of `expected_mint`
/// to the treasury's ATA, authorised by `player`, for at least `min_amount`.
/// Verifies the on-wire `decimals` byte matches `expected_decimals` as a second
/// line of defense against forged-mint attacks (a real TransferChecked carries
/// the mint's decimal — mismatched ones reject).
fn verify_spl_transfer_for_mint_in_tx(
    instructions_sysvar: &AccountInfo,
    expected_mint: &Pubkey,
    expected_decimals: u8,
    treasury_wallet: &Pubkey,
    player: &Pubkey,
    min_amount: u64,
) -> Result<()> {
    let mut i: usize = 0;
    loop {
        let ix = match ix_sysvar::load_instruction_at_checked(i, instructions_sysvar) {
            Ok(ix) => ix,
            Err(_) => break,
        };
        i += 1;
        if ix.program_id != SPL_TOKEN_PROGRAM_ID {
            continue;
        }
        if ix.data.is_empty() || ix.data[0] != 0x0c {
            continue;
        }
        // TransferChecked layout: [disc:1][amount:u64 LE][decimals:u8] = 10 bytes
        if ix.data.len() < 10 {
            continue;
        }
        // Accounts: [source, mint, destination, authority, ...signers]
        if ix.accounts.len() < 4 {
            continue;
        }
        let amount = u64::from_le_bytes(ix.data[1..9].try_into().unwrap());
        let on_wire_decimals = ix.data[9];
        let mint = ix.accounts[1].pubkey;
        let destination = ix.accounts[2].pubkey;
        let authority = ix.accounts[3].pubkey;

        if mint != *expected_mint {
            continue;
        }
        // Decimal mismatch is a HARD reject (not just skip) — if mint matches
        // but decimals are forged, the player is signing a malformed tx.
        require!(on_wire_decimals == expected_decimals, ArcadeError::DecimalsMismatch);
        if authority != *player {
            continue;
        }
        let expected_ata = derive_ata(treasury_wallet, &mint);
        if destination != expected_ata {
            continue;
        }
        if amount < min_amount {
            continue;
        }
        return Ok(());
    }
    err!(ArcadeError::PaymentTransferNotFound)
}

/// Confirm the current tx contains a native SOL `SystemProgram::Transfer` from
/// `player` to `treasury_wallet` for at least `min_amount_lamports`.
fn verify_sol_transfer_in_tx(
    instructions_sysvar: &AccountInfo,
    treasury_wallet: &Pubkey,
    player: &Pubkey,
    min_amount_lamports: u64,
) -> Result<()> {
    let mut i: usize = 0;
    loop {
        let ix = match ix_sysvar::load_instruction_at_checked(i, instructions_sysvar) {
            Ok(ix) => ix,
            Err(_) => break,
        };
        i += 1;
        if ix.program_id != solana_program::system_program::ID {
            continue;
        }
        // SystemProgram::Transfer layout: [tag:4 u32 LE = 2][lamports:8 LE] = 12 bytes
        if ix.data.len() < 12 {
            continue;
        }
        let tag = u32::from_le_bytes(ix.data[0..4].try_into().unwrap());
        if tag != 2 {
            continue;
        }
        // Accounts: [from (signer), to]
        if ix.accounts.len() < 2 {
            continue;
        }
        let from = ix.accounts[0].pubkey;
        let to = ix.accounts[1].pubkey;
        if from != *player || to != *treasury_wallet {
            continue;
        }
        let amount = u64::from_le_bytes(ix.data[4..12].try_into().unwrap());
        if amount < min_amount_lamports {
            continue;
        }
        return Ok(());
    }
    err!(ArcadeError::PaymentTransferNotFound)
}

/// Convert `amount_micro_usd` to native smallest-unit (lamports or token quarks)
/// using a scaled fixed-point rate.
///   smallest_unit = (amount_micro_usd × RATE_SCALE_FACTOR) / rate_scaled
fn convert_usd_to_raw(amount_micro_usd: u64, rate_scaled: u64) -> Result<u64> {
    require!(rate_scaled > 0, ArcadeError::ExchangeRateStale);
    let numerator = (amount_micro_usd as u128)
        .checked_mul(RATE_SCALE_FACTOR)
        .ok_or(ArcadeError::Overflow)?;
    let raw = numerator
        .checked_div(rate_scaled as u128)
        .ok_or(ArcadeError::Overflow)?;
    u64::try_from(raw).map_err(|_| ArcadeError::Overflow.into())
}

/// Apply a slippage floor: `min_acceptable = expected × (10000 - slippage_bps) / 10000`
fn apply_slippage_floor(expected: u64, slippage_bps: u64) -> Result<u64> {
    let num = 10_000_u128
        .checked_sub(slippage_bps as u128)
        .ok_or(ArcadeError::Overflow)?;
    let floor = (expected as u128)
        .checked_mul(num)
        .ok_or(ArcadeError::Overflow)?
        .checked_div(10_000)
        .ok_or(ArcadeError::Overflow)?;
    u64::try_from(floor).map_err(|_| ArcadeError::Overflow.into())
}

/// Validate a handle against charset / length / reserved-list rules.
/// `[a-z0-9_]{3,32}` and not in RESERVED_HANDLES.
fn validate_handle(s: &str) -> Result<()> {
    require!(s.len() >= MIN_HANDLE_LEN, ArcadeError::HandleTooShort);
    require!(s.len() <= MAX_HANDLE_LEN, ArcadeError::HandleTooLong);
    require!(
        s.bytes().all(|b| matches!(b, b'a'..=b'z' | b'0'..=b'9' | b'_')),
        ArcadeError::HandleInvalidChars
    );
    require!(
        !RESERVED_HANDLES.iter().any(|&r| r == s),
        ArcadeError::HandleReserved
    );
    Ok(())
}

/// Validate a bio: bytes only — printable + newline allowed; block control
/// bytes (`<0x20` except `\n`) and DEL (`0x7F`).
fn validate_bio(s: &str) -> Result<()> {
    for b in s.bytes() {
        let ok = b >= 0x20 || b == 0x0A;
        require!(ok && b != 0x7F, ArcadeError::BioInvalidChars);
    }
    Ok(())
}

/// Minimal base64 encoder (RFC 4648 std alphabet, no padding). Inline to
/// avoid adding a crate dep for just one helper. Output is ~1.333× input size.
fn base64_encode(data: &[u8]) -> String {
    const ALPHABET: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    let mut i = 0;
    while i + 3 <= data.len() {
        let n = ((data[i] as u32) << 16) | ((data[i + 1] as u32) << 8) | (data[i + 2] as u32);
        out.push(ALPHABET[((n >> 18) & 0x3f) as usize] as char);
        out.push(ALPHABET[((n >> 12) & 0x3f) as usize] as char);
        out.push(ALPHABET[((n >> 6) & 0x3f) as usize] as char);
        out.push(ALPHABET[(n & 0x3f) as usize] as char);
        i += 3;
    }
    let rem = data.len() - i;
    if rem == 1 {
        let n = (data[i] as u32) << 16;
        out.push(ALPHABET[((n >> 18) & 0x3f) as usize] as char);
        out.push(ALPHABET[((n >> 12) & 0x3f) as usize] as char);
        out.push('=');
        out.push('=');
    } else if rem == 2 {
        let n = ((data[i] as u32) << 16) | ((data[i + 1] as u32) << 8);
        out.push(ALPHABET[((n >> 18) & 0x3f) as usize] as char);
        out.push(ALPHABET[((n >> 12) & 0x3f) as usize] as char);
        out.push(ALPHABET[((n >> 6) & 0x3f) as usize] as char);
        out.push('=');
    }
    out
}

// ============================================================================
// Errors
// ============================================================================

#[error_code]
pub enum ArcadeError {
    #[msg("Only the admin can call this instruction.")]
    AdminOnly,
    #[msg("Profile owner does not match the signer.")]
    ProfileOwnerMismatch,
    #[msg("Game slug exceeds the maximum length.")]
    SlugTooLong,
    #[msg("Game display name exceeds the maximum length.")]
    NameTooLong,
    #[msg("Game ID must be > 0 and match config.next_game_id.")]
    InvalidGameId,
    #[msg("Game ID does not match the expected next_game_id.")]
    GameIdMismatch,
    #[msg("Game ID counter overflowed u8.")]
    GameIdOverflow,
    #[msg("Integer overflow.")]
    Overflow,
    #[msg("Invalid avatar source (must be 0..=3).")]
    InvalidAvatarSource,
    #[msg("Invalid cosmetic ID (out of bitmap range).")]
    InvalidCosmeticId,
    #[msg("Cosmetic not owned by this player.")]
    CosmeticNotOwned,
    #[msg("Variant field too long.")]
    VariantTooLong,
    #[msg("Meta field too long.")]
    MetaTooLong,
    #[msg("GPX5 memo exceeds MAX_MEMO_LEN.")]
    MemoTooLong,
    #[msg("Session duration must be > 0.")]
    InvalidDuration,
    #[msg("Invalid payment category (must be 0..=3).")]
    InvalidPaymentCategory,
    #[msg("Payment amount below minimum ($0.01 / 10_000 micro-USD).")]
    PaymentBelowMin,
    #[msg("Payment amount above maximum ($100 / 100_000_000 micro-USD).")]
    PaymentAboveMax,
    #[msg("Self-referral is not allowed.")]
    SelfReferralNotAllowed,
    #[msg("Referrer must have an open PlayerProfile — referrer_profile account missing.")]
    ReferrerProfileRequired,
    #[msg("Passed referrer_profile does not match the expected referrer wallet.")]
    ReferrerProfileMismatch,
    #[msg("external_ref string exceeds MAX_EXTERNAL_REF_LEN.")]
    ExternalRefTooLong,
    #[msg("VERIFIED payment must include an external_ref or be paired with commit_session_replay.")]
    VerifiedRefRequired,
    #[msg("ScoreCommit amount must be exactly SCORE_COMMIT_MICRO_USD ($0.05).")]
    InvalidScoreCommitAmount,
    #[msg("VERIFIED commit amount must be exactly VERIFIED_COMMIT_MICRO_USD ($0.15).")]
    InvalidVerifiedAmount,
    #[msg("ReplayReceipt mint amount must be exactly REPLAY_RECEIPT_MICRO_USD ($0.25).")]
    InvalidReplayReceiptAmount,
    #[msg("cNFT wrap amount must be exactly CNFT_WRAP_MICRO_USD ($0.50).")]
    InvalidCnftWrapAmount,
    #[msg("Only the current receipt owner can call this instruction.")]
    NotReceiptOwner,
    #[msg("Receipt is wrapped as a cNFT — unwrap first before closing.")]
    ReceiptWrappedAsCnft,
    #[msg("Score must be > 0.")]
    InvalidScore,
    #[msg("new_owner cannot be the default (zero) pubkey.")]
    InvalidNewOwner,
    #[msg("Move log is empty.")]
    MoveLogEmpty,
    #[msg("Move log exceeds MAX_MOVE_LOG_BYTES (400).")]
    MoveLogTooLong,
    // ── v1.2 security-hardening errors ──
    #[msg("No matching SPL TransferChecked of an accepted stablecoin to treasury found in tx.")]
    PaymentTransferNotFound,
    #[msg("Required record_payment of the expected category + amount was not bundled in the same tx.")]
    RequiredPaymentMissing,
    #[msg("This instruction may appear at most once per tx.")]
    DuplicateIxInTx,
    #[msg("Instruction deadline has expired.")]
    InstructionExpired,
    #[msg("Instruction deadline is too far in the future (> MAX_DEADLINE_FUTURE_SEC).")]
    DeadlineTooFar,
    #[msg("$GAMER-paid actions are not yet supported (v1.3).")]
    GamerPaymentsDisabled,
    // ── v1.3 multi-token payment errors ──
    #[msg("Payment mint is not in the allowlist and is not $GAME / SOL.")]
    PaymentMintNotAllowed,
    #[msg("Exchange rate is stale — bot has not pushed an update within the staleness window.")]
    ExchangeRateStale,
    #[msg("Payment amount is below the quoted minimum (after slippage tolerance).")]
    PaymentUnderpaid,
    #[msg("Stablecoin payment amount_micro_usd must equal payment_amount_raw (both 6-decimal).")]
    StablecoinAmountMismatch,
    #[msg("TransferChecked decimals byte does not match the expected mint decimals.")]
    DecimalsMismatch,
    #[msg("ExchangeRatesConfig PDA missing or admin mismatch.")]
    RatesConfigMismatch,
    // ── Identity (ProfileExtV2 + HandleClaim) ──
    #[msg("Handle too short (min 3 chars).")]
    HandleTooShort,
    #[msg("Handle too long (max 32 chars).")]
    HandleTooLong,
    #[msg("Handle contains invalid characters (allowed: a-z, 0-9, _).")]
    HandleInvalidChars,
    #[msg("Handle is reserved.")]
    HandleReserved,
    #[msg("Handle is unchanged — no-op rejected (would conflict with itself in same tx).")]
    HandleUnchanged,
    #[msg("Bio too long (max 140 bytes).")]
    BioTooLong,
    #[msg("Bio contains forbidden control characters.")]
    BioInvalidChars,
    #[msg("HandleClaim wallet does not match the signer.")]
    HandleClaimMismatch,
    #[msg("Wallet already has a handle; the existing HandleClaim must be passed for rent refund.")]
    OldHandleClaimRequired,
    #[msg("Wallet has no current handle — do not pass an old HandleClaim.")]
    OldHandleClaimUnexpected,
}
