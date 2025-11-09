/* Node 18+ runtime (long-lived process) */

import {
  Connection, PublicKey, Keypair, Transaction,
  LAMPORTS_PER_SOL, ComputeBudgetProgram, SystemProgram
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  getMint
} from "@solana/spl-token";
import bs58 from "bs58";

/* ================== REMOTE LOG MIRROR ================== */
const SERVER_URL = process.env.SERVER_URL || "http://localhost:4000";
async function postLogToServer(msg: string) {
  try {
    await fetch(`${SERVER_URL}/api/ingest-log`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ msg }),
    });
  } catch (_) {}
}

const _log = console.log;
console.log = (...args: any[]) => {
  const msg = args.map(a => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
  if (/\[CLAIM\]|\[AIRDROP\]/.test(msg)) postLogToServer(msg);
  _log(...args);
};

/* ================= CONFIG ================= */
const TRACKED_MINT = process.env.TRACKED_MINT || "";
const REWARD_WALLET = process.env.REWARD_WALLET || "";
const DEV_WALLET_PRIVATE_KEY = process.env.DEV_WALLET_PRIVATE_KEY || "";
const HELIUS_RPC = process.env.HELIUS_RPC || "";
const QUICKNODE_RPC = process.env.QUICKNODE_RPC || "";
const PUMPORTAL_KEY = (process.env.PUMPORTAL_KEY || "").trim();
const PUMPORTAL_BASE = "https://pumpportal.fun";
const PRIORITY_FEE_MICRO_LAMPORTS = Number(process.env.PRIORITY_FEE_MICRO_LAMPORTS ?? 5000);
const COMPUTE_UNIT_LIMIT = Number(process.env.COMPUTE_UNIT_LIMIT ?? 400000);

if (!TRACKED_MINT || !REWARD_WALLET || !DEV_WALLET_PRIVATE_KEY)
  throw new Error("Missing TRACKED_MINT, REWARD_WALLET, or DEV_WALLET_PRIVATE_KEY");
if (!HELIUS_RPC) throw new Error("Missing HELIUS_RPC");

/* ================= CONNECTION ================= */
const RPCS = [HELIUS_RPC, QUICKNODE_RPC].filter(Boolean);
let rpcIdx = 0;
function newConn() { return new Connection(RPCS[rpcIdx]!, "confirmed"); }
function rotateConn() { rpcIdx = (rpcIdx + 1) % RPCS.length; return newConn(); }
let connection = newConn();

function toKeypair(secret: string) {
  try { return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(secret))); }
  catch { return Keypair.fromSecretKey(bs58.decode(secret)); }
}
const devWallet = toKeypair(DEV_WALLET_PRIVATE_KEY);
const holdersMintPk = new PublicKey(TRACKED_MINT);

/* ================= UTILS ================= */
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
function looksRetryable(m: string) {
  return /429|timeout|rate.?limit|temporar|ECONN|ETIMEDOUT|blockhash|FetchError|TLS|ENOTFOUND/i.test(m);
}
async function withRetries<T>(fn: (c: Connection) => Promise<T>, tries = 5) {
  let c = connection, last: any;
  for (let i = 0; i < tries; i++) {
    try { return await fn(c); }
    catch (e: any) {
      last = e;
      const msg = String(e?.message || e);
      if (i < tries - 1 && looksRetryable(msg) && RPCS.length > 1) {
        c = (connection = rotateConn());
        await sleep(250 * (i + 1));
        continue;
      }
      break;
    }
  }
  throw last;
}

/* ================= PUMPPORTAL HELPERS ================= */
function portalUrl(path: string) {
  const u = new URL(path, PUMPORTAL_BASE);
  if (PUMPORTAL_KEY && !u.searchParams.has("api-key")) u.searchParams.set("api-key", PUMPORTAL_KEY);
  return u.toString();
}
async function callPumportal(path: string, body: any, idemKey: string) {
  const url = portalUrl(path);
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${PUMPORTAL_KEY}`,
      "Idempotency-Key": idemKey,
    },
    body: JSON.stringify(body),
  });
  const txt = await res.text();
  let json: any = {};
  try { json = txt ? JSON.parse(txt) : {}; } catch {}
  return { res, json };
}
function extractSig(j: any): string | null {
  return j?.signature || j?.tx || j?.txid || j?.txId || j?.result || j?.sig || null;
}

/* ================= BALANCES ================= */
async function getSolBalance(conn: Connection, pubkey: PublicKey) {
  return (await conn.getBalance(pubkey, "confirmed")) / LAMPORTS_PER_SOL;
}

/* ================= HOLDERS ================= */
async function getHoldersAllBase(mint: PublicKey): Promise<Array<{ wallet: string; amountBase: bigint }>> {
  async function scan(pid: string, filter165 = false) {
    const filters: any[] = [{ memcmp: { offset: 0, bytes: mint.toBase58() } }];
    if (filter165) filters.unshift({ dataSize: 165 });
    const accs = await withRetries((c: Connection) =>
      c.getParsedProgramAccounts(new PublicKey(pid), { filters })
    );
    const map = new Map<string, bigint>();
    for (const it of accs as any[]) {
      const info = (it as any).account.data.parsed.info;
      const owner = info?.owner as string | undefined;
      const amt = BigInt(info?.tokenAmount?.amount || "0");
      if (!owner || amt <= 0n) continue;
      map.set(owner, (map.get(owner) ?? 0n) + amt);
    }
    return map;
  }
  const out = new Map<string, bigint>();
  try { for (const [k, v] of await scan(TOKEN_PROGRAM_ID.toBase58(), true)) out.set(k, (out.get(k) ?? 0n) + v); } catch {}
  try { for (const [k, v] of await scan(TOKEN_2022_PROGRAM_ID.toBase58(), false)) out.set(k, (out.get(k) ?? 0n) + v); } catch {}
  return Array.from(out.entries()).map(([wallet, amountBase]) => ({ wallet, amountBase }));
}

/* ================= CLAIM ================= */
let lastClaimState: null | { claimedSol: number; claimSig: string | null } = null;

async function triggerClaimAtStart() {
  console.log("💰 [CLAIM] Collecting creator fees...");
  const preSol = await getSolBalance(connection, devWallet.publicKey);
  const { res, json } = await callPumportal(
    "/api/trade",
    { action: "collectCreatorFee", priorityFee: 0.000001, pool: "pump", mint: TRACKED_MINT },
    `claim:${Date.now()}`
  );
  if (!res.ok) throw new Error(`Claim failed ${res.status}`);
  const claimSig = extractSig(json);
  await sleep(3000);
  const postSol = await getSolBalance(connection, devWallet.publicKey);
  const delta = Math.max(0, parseFloat((postSol - preSol).toFixed(6)));
  console.log(delta > 0 ? `🟢 [CLAIM] Claimed ${delta} SOL | Tx: ${claimSig}` : `⚪ [CLAIM] 0 SOL change | Tx: ${claimSig}`);
  lastClaimState = { claimedSol: delta, claimSig };
}

/* ================= SOL AIRDROP ================= */
async function distributeSolProportional(weightsIn: Array<{ wallet: string; weight: bigint }>, totalLamportsToSend: bigint) {
  const seen = new Set<string>();
  const weights = weightsIn.filter(it => {
    const w = it.wallet;
    if (!w) return false;
    if (w === devWallet.publicKey.toBase58()) return false;
    if (seen.has(w)) return false;
    if (it.weight <= 0n) return false;
    seen.add(w);
    return true;
  });
  if (!weights.length) return console.log("⚪ [AIRDROP] No eligible holders.");

  const totalWeight = weights.reduce((a, it) => a + it.weight, 0n);
  if (totalWeight <= 0n) return console.log("⚪ [AIRDROP] Total weight is zero.");

  console.log(`🎯 [AIRDROP] ${weights.length} eligible | ${(Number(totalLamportsToSend) / LAMPORTS_PER_SOL).toFixed(6)} SOL total | Proportional`);

  const BATCH = 6;
  const PARALLEL = 6;
  const GAP_MS = 1200;
  const groups: Array<typeof weights> = [];
  for (let i = 0; i < weights.length; i += BATCH) groups.push(weights.slice(i, i + BATCH));

  for (let i = 0; i < groups.length; i += PARALLEL) {
    const wave = groups.slice(i, i + PARALLEL);
    const { blockhash } = await connection.getLatestBlockhash("finalized");
    console.log(`🌊 [AIRDROP] Sending SOL wave ${i / PARALLEL + 1}/${Math.ceil(groups.length / PARALLEL)}`);

    await Promise.all(wave.map(async (group, gi) => {
      const ixs = [];
      for (const { wallet, weight } of group) {
        try {
          const to = new PublicKey(wallet);
          const amt = (totalLamportsToSend * weight) / totalWeight;
          if (amt <= 0n) continue;
          ixs.push(SystemProgram.transfer({ fromPubkey: devWallet.publicKey, toPubkey: to, lamports: Number(amt) }));
        } catch (e) {
          console.warn(`[AIRDROP] invalid ${wallet}: ${String((e as any)?.message || e)}`);
        }
      }
      if (!ixs.length) return;
      try {
        const tx = new Transaction();
        tx.add(
          ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNIT_LIMIT }),
          ComputeBudgetProgram.setComputeUnitPrice({ microLamports: PRIORITY_FEE_MICRO_LAMPORTS }),
          ...ixs
        );
        tx.feePayer = devWallet.publicKey;
        tx.recentBlockhash = blockhash;
        tx.sign(devWallet);
        const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
        await connection.confirmTransaction(sig, "confirmed");
        console.log(`✅ [AIRDROP] SOL batch ${i + gi + 1} | ${group.length} holders | ${sig}`);
      } catch (e: any) {
        console.warn(`⚠️ [AIRDROP] batch failed: ${String(e?.message || e)}`);
      }
    }));
    await sleep(GAP_MS);
  }

  console.log("🎉 [AIRDROP] SOL proportional complete.");
}

/* ================= SNAPSHOT & DISTRIBUTE ================= */
async function snapshotAndDistributeSOL() {
  console.log("🎁 [AIRDROP] Snapshotting holders...");
  const holdersAll = await getHoldersAllBase(holdersMintPk);
  if (!holdersAll.length) return console.log("⚪ [AIRDROP] No holders found.");

  const trackedInfo = await withRetries(c => c.getAccountInfo(holdersMintPk, "confirmed"), 5);
  if (!trackedInfo) throw new Error("Tracked mint account not found");
  const trackedIs22 = trackedInfo.owner.equals(TOKEN_2022_PROGRAM_ID);
  const trackedProgram = trackedIs22 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
  const trackedMintInfo = await withRetries(c => getMint(c, holdersMintPk, "confirmed", trackedProgram), 5);
  const trackedDecimals = trackedMintInfo.decimals;

  const scale = 10n ** BigInt(trackedDecimals);
  const MIN_BASE = 500_000n * scale;
  const MAX_BASE = 50_000_000n * scale;

  const eligible = holdersAll
    .filter(h => h.amountBase >= MIN_BASE && h.amountBase <= MAX_BASE)
    .map(h => ({ wallet: h.wallet, weight: h.amountBase }));

  if (!eligible.length) return console.log("⚪ [AIRDROP] No eligible holders after blacklist.");

  const claimed = lastClaimState?.claimedSol ?? 0;
  const lamportsToSend = BigInt(Math.floor(claimed * 0.6 * LAMPORTS_PER_SOL));
  if (lamportsToSend <= 0n) return console.log("⚪ [AIRDROP] No SOL available to airdrop.");

  await distributeSolProportional(eligible, lamportsToSend);
}

/* ================= MAIN LOOP ================= */
async function loop() {
  while (true) {
    try {
      console.log("\n================= 🚀 NEW CYCLE =================");
      await triggerClaimAtStart();
      console.log("⏳ 30s pause → next: SOL AIRDROP");
      await sleep(30_000);
      await snapshotAndDistributeSOL();
      console.log("🕐 5m cooldown before next cycle...");
      await sleep(300_000);
    } catch (e: any) {
      console.error("💥 [CYCLE ERROR]", e?.message || e);
      await sleep(5000);
    }
  }
}

loop().catch(e => {
  console.error("💣 bananaWorker crashed", e?.message || e);
  process.exit(1);
});

