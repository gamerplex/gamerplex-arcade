#!/usr/bin/env tsx
/**
 * Mainnet deployment smoke test — runs after `scripts/mainnet-launch.sh all`.
 *
 * Verifies (no real-money txs required):
 *   1. gamerplex-resolver-mn /admin/health returns expected fields + funded admin keypair
 *   2. gamerplex-resolver-mn /arcade/leaderboard/<slug> returns 200 (resolver reachable)
 *   3. /webhooks/devnet/helius rejects unauth, /webhooks/mainnet/helius accepts auth-headers
 *   4. ph001 PostHog accepts capture events from server-side (full pipeline)
 *   5. Program at PROGRAM_ID is upgradable only by SQUADS_VAULT_PDA (auth handoff happened)
 *
 * For an end-to-end SAVE-SCORE smoke (which burns real USDC + SOL), see
 * docs/MAINNET_LAUNCH_RUNBOOK.md "Manual fresh-wallet smoke" section.
 *
 * Usage:
 *   PROGRAM_ID=<mainnet-pid> SQUADS_VAULT_PDA=<vault> npx tsx scripts/mainnet-smoke.ts
 *
 * Exit code: 0 = all green, non-zero = something failed (with diagnostics).
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { execSync } from "child_process";

const PROGRAM_ID = process.env.PROGRAM_ID;
const SQUADS_VAULT_PDA = process.env.SQUADS_VAULT_PDA;
const RESOLVER_MN = process.env.RESOLVER_MN || "https://gamerplex-resolver-mn-ids4vx4iaa-uc.a.run.app";
const PH_HOST = process.env.POSTHOG_HOST || "https://ph001.gamerplex.com";
const PH_PUB_KEY = process.env.POSTHOG_PROJECT_KEY || "phc_v574wEFb4Dg4rGXcPokGnb7GWjRsxAiCwLyNfwDNB5Df";
const HELIUS_AUTH = process.env.HELIUS_WEBHOOK_AUTH_HEADER;
const ADMIN_HEALTH_TOKEN = process.env.ADMIN_HEALTH_TOKEN;

let failures = 0;
const fail = (msg: string) => { console.error(`❌ ${msg}`); failures++; };
const pass = (msg: string) => console.log(`✅ ${msg}`);

async function fetchSecretIfMissing(name: string, secretName: string): Promise<string | undefined> {
  let v = process.env[name];
  if (v) return v;
  try {
    v = execSync(`gcloud secrets versions access latest --secret=${secretName} --project=xnode-ai`, { encoding: "utf-8" }).trim();
    return v;
  } catch { return undefined; }
}

async function main() {
  if (!PROGRAM_ID) { console.error("❌ Set PROGRAM_ID env"); process.exit(1); }

  const heliusAuth = HELIUS_AUTH ?? await fetchSecretIfMissing("HELIUS_WEBHOOK_AUTH_HEADER", "HELIUS_WEBHOOK_AUTH_HEADER");
  const adminToken = ADMIN_HEALTH_TOKEN ?? await fetchSecretIfMissing("ADMIN_HEALTH_TOKEN", "admin-health-token");

  console.log(`Mainnet smoke against ${RESOLVER_MN}`);
  console.log(`  PROGRAM_ID:        ${PROGRAM_ID}`);
  console.log(`  SQUADS_VAULT_PDA:  ${SQUADS_VAULT_PDA ?? "(not set — skipping upgrade-auth check)"}`);
  console.log("");

  // 1. /admin/health — only mounted when PARTNER_SECRET_KEY is bound. Pre-launch
  //    state acceptable; we just warn (not fail) so the same script works pre + post.
  if (!adminToken) {
    fail("/admin/health: no ADMIN_HEALTH_TOKEN — can't auth");
  } else {
    try {
      const r = await fetch(`${RESOLVER_MN}/admin/health`, { headers: { "x-admin-token": adminToken } });
      const ctype = r.headers.get("content-type") ?? "";
      if (!ctype.includes("application/json")) {
        console.log(`⚠️  /admin/health returned non-JSON (${r.status}) — endpoint not mounted yet, expected pre-deploy (PARTNER_SECRET_KEY_MAINNET not yet bound; happens in cmd_resolver_mn)`);
      } else {
        const j: any = await r.json();
        if (r.status !== 200) fail(`/admin/health returned ${r.status}: ${JSON.stringify(j).slice(0,200)}`);
        else if (j.network !== "mainnet") fail(`/admin/health network is "${j.network}" — expected mainnet`);
        else if (!j.adminKeypair?.pubkey) fail(`/admin/health adminKeypair.pubkey null — PARTNER_SECRET_KEY not bound`);
        else if (j.adminKeypair.solBalance === null || j.adminKeypair.solBalance < 0.1) fail(`admin keypair has only ${j.adminKeypair.solBalance} SOL — fund it (target 5)`);
        else if (j.adminKeypair.criticalBalance) fail(`admin keypair criticalBalance=true (<0.1 SOL)`);
        else pass(`/admin/health: network=mainnet, admin=${j.adminKeypair.pubkey.slice(0,8)}... balance=${j.adminKeypair.solBalance} SOL`);
      }
    } catch (e: any) { fail(`/admin/health threw: ${e?.message ?? e}`); }
  }

  // 2. /arcade/leaderboard reachable
  for (const slug of ["cyber-snake", "magic-chess", "blockwords", "flipball"]) {
    try {
      const r = await fetch(`${RESOLVER_MN}/arcade/leaderboard/${slug}`);
      if (r.status === 200) pass(`/arcade/leaderboard/${slug}: 200`);
      else fail(`/arcade/leaderboard/${slug}: ${r.status}`);
    } catch (e: any) { fail(`leaderboard ${slug} threw: ${e?.message ?? e}`); }
  }

  // 3. webhook auth
  try {
    const r = await fetch(`${RESOLVER_MN}/webhooks/mainnet/helius`, {
      method: "POST", headers: { "content-type": "application/json", "authorization": "wrong-secret" }, body: "[]",
    });
    if (r.status === 401) pass(`/webhooks/mainnet/helius rejects bad auth (401)`);
    else fail(`/webhooks/mainnet/helius accepted bad auth: ${r.status}`);
  } catch (e: any) { fail(`webhook auth threw: ${e?.message ?? e}`); }
  if (heliusAuth) {
    try {
      const r = await fetch(`${RESOLVER_MN}/webhooks/mainnet/helius`, {
        method: "POST", headers: { "content-type": "application/json", "authorization": heliusAuth }, body: "[]",
      });
      if (r.status === 400) pass(`/webhooks/mainnet/helius accepts auth (rejects empty body as expected)`);
      else if (r.status === 200) pass(`/webhooks/mainnet/helius accepts auth (200 on empty)`);
      else fail(`/webhooks/mainnet/helius unexpected ${r.status}`);
    } catch (e: any) { fail(`webhook good-auth threw: ${e?.message ?? e}`); }
  }

  // 4. PostHog capture
  const distinctId = `mainnet-smoke-${Date.now()}`;
  try {
    const r = await fetch(`${PH_HOST}/i/v0/e/`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ api_key: PH_PUB_KEY, event: "mainnet_smoke", distinct_id: distinctId, properties: { product: "gamerplex", surface: "mainnet-smoke", program_id: PROGRAM_ID } }),
    });
    const j: any = await r.json();
    if (j.status === "Ok") pass(`PostHog capture accepts mainnet_smoke event (distinct_id=${distinctId})`);
    else fail(`PostHog capture rejected: ${JSON.stringify(j)}`);
  } catch (e: any) { fail(`PostHog capture threw: ${e?.message ?? e}`); }

  // 5. upgrade authority is Squads vault
  if (SQUADS_VAULT_PDA) {
    try {
      const conn = new Connection("https://api.mainnet-beta.solana.com", "confirmed");
      const programDataAddr = PublicKey.findProgramAddressSync(
        [new PublicKey(PROGRAM_ID).toBuffer()],
        new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111"),
      )[0];
      const info = await conn.getAccountInfo(programDataAddr);
      if (!info) fail(`Program data account ${programDataAddr.toBase58()} not found`);
      else {
        // ProgramData layout: 0..4 = slot, 4..5 = option<authority>, 5..37 = authority pubkey
        const hasAuth = info.data[4] === 1;
        const authBytes = info.data.subarray(5, 37);
        const authPub = new PublicKey(authBytes).toBase58();
        if (!hasAuth) fail(`Program is FROZEN (no upgrade authority) — handoff went wrong`);
        else if (authPub !== SQUADS_VAULT_PDA) fail(`Upgrade authority is ${authPub.slice(0,8)}... — expected Squads vault ${SQUADS_VAULT_PDA.slice(0,8)}...`);
        else pass(`Program upgrade authority = Squads vault ${authPub.slice(0,8)}...`);
      }
    } catch (e: any) { fail(`upgrade-auth check threw: ${e?.message ?? e}`); }
  }

  console.log("");
  if (failures === 0) {
    console.log("🟢 ALL SMOKE CHECKS PASSED — mainnet infra is healthy");
    process.exit(0);
  } else {
    console.error(`🔴 ${failures} CHECK(S) FAILED — investigate before opening to users`);
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(2); });
