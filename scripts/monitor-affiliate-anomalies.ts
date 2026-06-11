#!/usr/bin/env tsx
/**
 * Affiliate anomaly monitor.
 *
 * Polls all PlayerProfile accounts under the arcade program and computes
 * velocity metrics. Alerts when thresholds are crossed.
 *
 * Companion to ENGINEERING/MAINNET_DEPLOY_RUNBOOK.md Section 9.
 * Defends against the A4 (fresh-wallet farming) and A1 (sock-puppet)
 * attack classes documented in ENGINEERING/SECURITY_LEARNINGS.md.
 *
 * Usage:
 *   # One-shot scan (manual inspection)
 *   npx tsx scripts/monitor-affiliate-anomalies.ts
 *
 *   # Continuous (every 5 min) — for use in a small Cloud Run / NixOS service
 *   POLL_INTERVAL_SEC=300 npx tsx scripts/monitor-affiliate-anomalies.ts --watch
 *
 *   # Mainnet (defaults to devnet)
 *   SOLANA_NETWORK=mainnet SOLANA_RPC=<paid-rpc> npx tsx scripts/monitor-affiliate-anomalies.ts
 *
 *   # Wire alerts to a webhook (Discord/Slack/PagerDuty)
 *   ALERT_WEBHOOK=https://discord.com/api/webhooks/... npx tsx scripts/monitor-affiliate-anomalies.ts
 *
 * Thresholds (override via env):
 *   REFERRED_24H_ALERT        Default 20 — alert if a profile gains >N referred_payers in 24h
 *   REFERRED_1H_ALERT         Default 5  — alert if >N in 1h
 *   EARNED_1H_ALERT_MICRO     Default 1_000_000 ($1) — alert if accrual >N micro-USD in 1h
 *   PROFILES_HOUR_ALERT       Default 50 — alert if total NEW profiles in last hour >N (sybil burst)
 *   POLL_INTERVAL_SEC         Default 300 (5 min) — only used with --watch
 */

import { Connection, PublicKey } from "@solana/web3.js";
import { AnchorProvider, BN, Program, type Idl } from "@coral-xyz/anchor";
import * as fs from "fs";
import * as path from "path";

const NETWORK = (process.env.SOLANA_NETWORK as "mainnet" | "devnet") || "devnet";
const RPC =
  process.env.SOLANA_RPC ||
  (NETWORK === "mainnet" ? "https://api.mainnet-beta.solana.com" : "https://api.devnet.solana.com");
const PROGRAM_ID = new PublicKey("4FVwdxxBp6PTax2tAcPyHE9rYt8tyNf2YBGrSnSqmx8t");
const ALERT_WEBHOOK = process.env.ALERT_WEBHOOK || "";

const T_REFERRED_24H = Number(process.env.REFERRED_24H_ALERT || 20);
const T_REFERRED_1H = Number(process.env.REFERRED_1H_ALERT || 5);
const T_EARNED_1H_MICRO = Number(process.env.EARNED_1H_ALERT_MICRO || 1_000_000);
const T_PROFILES_HOUR = Number(process.env.PROFILES_HOUR_ALERT || 50);

const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_SEC || 300) * 1000;
const IS_WATCH = process.argv.includes("--watch");

interface ProfileSnapshot {
  pubkey: string;
  wallet: string;
  referrer: string;
  affiliateEarnedAccruedMicro: number;
  affiliateReferredPayers: number;
  openedAt: number;
}

interface Anomaly {
  severity: "page" | "warn" | "info";
  profile: string;
  wallet: string;
  reason: string;
  metric: string;
}

function loadIdl(): Idl {
  const idlPath = path.join(__dirname, "..", "target", "idl", "gamerplex_arcade.json");
  if (!fs.existsSync(idlPath)) {
    throw new Error(
      `IDL not found at ${idlPath}. Run \`anchor build\` in gamerplex-arcade/ first.`
    );
  }
  return JSON.parse(fs.readFileSync(idlPath, "utf8")) as Idl;
}

function readonlyProgram(): Program {
  const conn = new Connection(RPC, "confirmed");
  // Readonly wallet (no signing) — we only fetch accounts
  const wallet = {
    publicKey: PublicKey.default,
    signTransaction: () => { throw new Error("readonly"); },
    signAllTransactions: () => { throw new Error("readonly"); },
  } as any;
  const provider = new AnchorProvider(conn, wallet, { commitment: "confirmed" });
  return new Program(loadIdl(), provider) as Program;
}

async function snapshotAllProfiles(program: Program): Promise<ProfileSnapshot[]> {
  // @ts-expect-error — generated account accessor name depends on the IDL
  const raw = await program.account.playerProfile.all();
  return raw.map((r: any) => {
    const a = r.account;
    return {
      pubkey: r.publicKey.toBase58(),
      wallet: a.wallet?.toBase58?.() ?? "?",
      referrer: a.referrer?.toBase58?.() ?? "default",
      affiliateEarnedAccruedMicro: (a.affiliateEarnedAccruedMicro as BN)?.toNumber?.() ?? 0,
      affiliateReferredPayers: a.affiliateReferredPayers ?? 0,
      openedAt: (a.openedAt as BN)?.toNumber?.() ?? 0,
    } satisfies ProfileSnapshot;
  });
}

function checkAnomalies(profiles: ProfileSnapshot[]): Anomaly[] {
  const anomalies: Anomaly[] = [];
  const nowSec = Math.floor(Date.now() / 1000);

  for (const p of profiles) {
    const ageHours = (nowSec - p.openedAt) / 3600;

    // A4 detector — fresh-wallet farming: rapid referral growth on a young profile
    if (p.affiliateReferredPayers >= T_REFERRED_24H && ageHours < 24) {
      anomalies.push({
        severity: "page",
        profile: p.pubkey,
        wallet: p.wallet,
        reason: `${p.affiliateReferredPayers} referred_payers in ${ageHours.toFixed(1)}h (threshold: ${T_REFERRED_24H} / 24h)`,
        metric: "referred_payers_velocity_24h",
      });
    }
    if (p.affiliateReferredPayers >= T_REFERRED_1H && ageHours < 1) {
      anomalies.push({
        severity: "page",
        profile: p.pubkey,
        wallet: p.wallet,
        reason: `${p.affiliateReferredPayers} referred_payers in ${ageHours.toFixed(2)}h (threshold: ${T_REFERRED_1H} / 1h)`,
        metric: "referred_payers_velocity_1h",
      });
    }

    // Bursty earning — accrual delta per hour
    if (p.affiliateEarnedAccruedMicro >= T_EARNED_1H_MICRO && ageHours < 1) {
      anomalies.push({
        severity: "page",
        profile: p.pubkey,
        wallet: p.wallet,
        reason: `accrued $${(p.affiliateEarnedAccruedMicro / 1e6).toFixed(2)} in ${ageHours.toFixed(2)}h`,
        metric: "earnings_velocity_1h",
      });
    }
  }

  // Total NEW profiles in last hour — sybil burst detector
  const newProfilesLastHour = profiles.filter((p) => nowSec - p.openedAt < 3600).length;
  if (newProfilesLastHour >= T_PROFILES_HOUR) {
    anomalies.push({
      severity: "page",
      profile: "<aggregate>",
      wallet: "<aggregate>",
      reason: `${newProfilesLastHour} new profiles opened in last hour (threshold: ${T_PROFILES_HOUR})`,
      metric: "new_profiles_per_hour",
    });
  }

  return anomalies;
}

interface Report {
  ts: string;
  network: string;
  totalProfiles: number;
  totalReferredPayers: number;
  totalAccruedUsd: number;
  newProfilesLastHour: number;
  top10ByReferredPayers: Array<{ profile: string; wallet: string; referredPayers: number; earnedUsd: number }>;
  anomalies: Anomaly[];
}

function buildReport(profiles: ProfileSnapshot[], anomalies: Anomaly[]): Report {
  const nowSec = Math.floor(Date.now() / 1000);
  const totalAccrued = profiles.reduce((s, p) => s + p.affiliateEarnedAccruedMicro, 0);
  const totalReferred = profiles.reduce((s, p) => s + p.affiliateReferredPayers, 0);
  const top10 = [...profiles]
    .sort((a, b) => b.affiliateReferredPayers - a.affiliateReferredPayers)
    .slice(0, 10)
    .map((p) => ({
      profile: p.pubkey,
      wallet: p.wallet,
      referredPayers: p.affiliateReferredPayers,
      earnedUsd: p.affiliateEarnedAccruedMicro / 1e6,
    }));

  return {
    ts: new Date(nowSec * 1000).toISOString(),
    network: NETWORK,
    totalProfiles: profiles.length,
    totalReferredPayers: totalReferred,
    totalAccruedUsd: totalAccrued / 1e6,
    newProfilesLastHour: profiles.filter((p) => nowSec - p.openedAt < 3600).length,
    top10ByReferredPayers: top10,
    anomalies,
  };
}

async function pushAlertWebhook(report: Report): Promise<void> {
  if (!ALERT_WEBHOOK || report.anomalies.length === 0) return;
  const lines = report.anomalies.map(
    (a) => `🚨 [${a.severity.toUpperCase()}] ${a.metric} — profile=${a.profile.slice(0, 8)}… wallet=${a.wallet.slice(0, 8)}… — ${a.reason}`
  );
  const payload = {
    content: [
      `**Affiliate anomaly alert** — ${NETWORK}`,
      `Profiles: ${report.totalProfiles} · Referred payers: ${report.totalReferredPayers} · Accrued: $${report.totalAccruedUsd.toFixed(2)}`,
      ...lines,
    ].join("\n"),
  };
  try {
    const r = await fetch(ALERT_WEBHOOK, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!r.ok) console.warn(`[ALERT] webhook returned ${r.status}`);
  } catch (e: any) {
    console.warn(`[ALERT] webhook failed: ${e?.message ?? e}`);
  }
}

function logReport(report: Report): void {
  console.log("─".repeat(72));
  console.log(`📊 ${report.ts}  net=${report.network}`);
  console.log(
    `   profiles=${report.totalProfiles}  referred_payers=${report.totalReferredPayers}  accrued=$${report.totalAccruedUsd.toFixed(2)}  new_1h=${report.newProfilesLastHour}`
  );
  if (report.top10ByReferredPayers[0]?.referredPayers > 0) {
    console.log("   top by referred_payers:");
    for (const r of report.top10ByReferredPayers) {
      if (r.referredPayers === 0) break;
      console.log(`     ${r.profile.slice(0, 8)}…  ${r.referredPayers} referees  $${r.earnedUsd.toFixed(2)} accrued`);
    }
  }
  if (report.anomalies.length) {
    console.log(`   🚨 anomalies (${report.anomalies.length}):`);
    for (const a of report.anomalies) {
      console.log(`     [${a.severity}] ${a.metric}  ${a.profile.slice(0, 8)}…  ${a.reason}`);
    }
  } else {
    console.log("   ✓ no anomalies");
  }
}

async function tick(program: Program): Promise<void> {
  try {
    const profiles = await snapshotAllProfiles(program);
    const anomalies = checkAnomalies(profiles);
    const report = buildReport(profiles, anomalies);
    logReport(report);
    if (anomalies.length) {
      await pushAlertWebhook(report);
    }
  } catch (e: any) {
    console.error(`[tick] failed: ${e?.message ?? e}`);
  }
}

async function main() {
  console.log(`affiliate-monitor  network=${NETWORK}  watch=${IS_WATCH}`);
  console.log(`  thresholds: ${T_REFERRED_24H}/24h ${T_REFERRED_1H}/1h $${T_EARNED_1H_MICRO/1e6}/1h ${T_PROFILES_HOUR} new/hour`);
  if (ALERT_WEBHOOK) console.log(`  webhook: configured`);

  const program = readonlyProgram();

  await tick(program);

  if (IS_WATCH) {
    console.log(`watching — polling every ${POLL_INTERVAL_MS / 1000}s`);
    setInterval(() => tick(program), POLL_INTERVAL_MS);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
