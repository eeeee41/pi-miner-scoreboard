/* =====================================================================
   Pi Miner — shared blockchain mining
   ---------------------------------------------------------------------
   Everyone mines the SAME chain, like Bitcoin:
     • meta/chain        the tip: latest height + hash, next difficulty, supply
     • chain/{height}    every block ever mined
   To mine block N, a miner takes the tip (block N-1), gathers up to 100
   trades that no block has confirmed yet, and searches for a nonce whose
   SHA-256 hash is below the target. The first miner to save a valid block
   wins the reward; everyone else drops their search and starts on N+1.

   Block header (what gets hashed):
     height|prevHash|timestamp|miner|reward|work|txRoot|nonce
   txRoot is the SHA-256 of the included trades, one per line:
     tradeId|buyer|seller|qty|price
   so changing any confirmed trade would break that block's hash.

   Difficulty ("work") = average number of hashes per block. A hash wins
   when its first 8 hex digits, read as a number, are below 2^32 / work.
   After each block the work is nudged toward one block per minute.
   ===================================================================== */

/* ---------- 1. Firebase config ---------- */
const firebaseConfig = {
  apiKey: "AIzaSyD--cjnr_sLzUe5W1zlPaooKCWQdFsKo-U",
  authDomain: "piminerscoreboard.firebaseapp.com",
  projectId: "piminerscoreboard",
  storageBucket: "piminerscoreboard.firebasestorage.app",
  messagingSenderId: "1005138898860",
  appId: "1:1005138898860:web:42d6634ea8022fa85e5409"
};

/* ---------- 2. Chain settings ---------- */
const BLOCK_REWARD = 50;           // Pi for the early blocks…
const HALVING_INTERVAL = 10000;    // …halving every 10,000 blocks (about 970,000 Pi can ever exist)
const TARGET_BLOCK_MS = 60000;     // difficulty aims for one block a minute across all miners
const START_WORK = 2 ** 26;        // average hashes for block #1 (~67 million)
const MIN_WORK = 2 ** 16;          // easiest allowed (~65 thousand hashes)
const MAX_WORK = 2 ** 32;          // hardest allowed (~4.3 billion hashes)
const MAX_BLOCK_TRADES = 100;      // trades confirmed per block
const THREADS = Math.max(1, Math.min(16, navigator.hardwareConcurrency || 4));
const CHAIN_SHOWN = 12;            // blocks listed on the Mine tab
const GENESIS_HASH = "0".repeat(64);

const rewardAt = (height) => Math.floor(BLOCK_REWARD / 2 ** Math.floor((height - 1) / HALVING_INTERVAL));
const clampWork = (w) => Math.round(Math.min(MAX_WORK, Math.max(MIN_WORK, w)));
const targetFor = (work) => Math.max(1, Math.floor(2 ** 32 / clampWork(work)));
const meetsTarget = (hash, target) => parseInt(hash.slice(0, 8), 16) < target;
const blockHeader = (b) => `${b.height}|${b.prevHash}|${b.timestamp}|${b.miner}|${b.reward}|${b.work}|${b.txRoot}|`;

// Nudge difficulty toward TARGET_BLOCK_MS, by at most a third per block
function nextWork(work, prevTimestamp, timestamp) {
  if (!prevTimestamp) return clampWork(work);
  const took = Math.max(1000, timestamp - prevTimestamp);
  const factor = Math.min(4 / 3, Math.max(3 / 4, TARGET_BLOCK_MS / took));
  return clampWork(work * factor);
}

/* ---------- 3. State ---------- */
const state = {
  session: 0,             // bumps on sign-in/out so stale async work is discarded
  user: null,
  running: false,         // Start/Stop toggle
  loopActive: false,
  mining: false,
  submitting: false,
  tip: { height: 0, hash: GENESIS_HASH, timestamp: 0, nextWork: START_WORK, supply: 0 },
  tipLoaded: false,
  blocks: [],             // latest blocks, newest first
  checked: new Map(),     // block hash -> true (valid) / false (doesn't add up)
  pending: 0,             // trades waiting for a block, all markets
  pendingBy: new Map(),   // market -> waiting trades
  tickers: [],            // company tickers (each has its own market)
  wallet: { coins: 0, blocksMined: 0, loaded: false },
  progress: 0             // hashes tried on the current block ÷ average needed
};
let auth = null, db = null, unsubs = [];

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tsMs = (t) => (t && t.toMillis ? t.toMillis() : typeof t === "number" ? t : Date.now());
const fmtTime = (ms) => (ms >= 60000 ? `${(ms / 60000).toFixed(1)} min` : ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms.toFixed(0)} ms`);
const fmtRate = (r) =>
  r >= 1e6 ? `${(r / 1e6).toFixed(2)} M hashes/s` : r >= 1e3 ? `${(r / 1e3).toFixed(1)} k hashes/s` : `${Math.round(r)} hashes/s`;
const fmtBig = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)} billion` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} million` : n >= 1e3 ? `${(n / 1e3).toFixed(0)} thousand` : String(n));
const ago = (t) => {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(t).toLocaleDateString();
};
const tipHash = () => state.tip.hash;

/* ---------- 4. SHA-256 ---------- */
async function sha256Hex(message) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(message));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/* ---------------------------------------------------------------------
   4b. MULTI-CORE MINER — one Web Worker per CPU thread.
   Worker i tries nonces i, i+N, i+2N, … so no two threads repeat work.
   Each runs a synchronous SHA-256 that hashes the fixed start of the
   header once per job and only re-hashes the blocks holding the nonce.
   Every winning hash is re-checked with crypto.subtle before it counts.
   --------------------------------------------------------------------- */
function minerWorkerMain() {
  const K = new Int32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ]);
  const IV = new Int32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const W = new Int32Array(64);
  const out = new Int32Array(8);

  function compress(st, words, off, dst) {
    for (let i = 0; i < 16; i++) W[i] = words[off + i];
    for (let i = 16; i < 64; i++) {
      const x = W[i - 15], y = W[i - 2];
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      W[i] = (W[i - 16] + s0 + W[i - 7] + s1) | 0;
    }
    let a = st[0], b = st[1], c = st[2], d = st[3], e = st[4], f = st[5], g = st[6], h = st[7];
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const t1 = (h + S1 + ((e & f) ^ (~e & g)) + K[i] + W[i]) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    dst[0] = (st[0] + a) | 0; dst[1] = (st[1] + b) | 0; dst[2] = (st[2] + c) | 0; dst[3] = (st[3] + d) | 0;
    dst[4] = (st[4] + e) | 0; dst[5] = (st[5] + f) | 0; dst[6] = (st[6] + g) | 0; dst[7] = (st[7] + h) | 0;
  }

  function toWords(bytes, words, from, to) {
    for (let i = from; i <= to; i++) {
      const j = i * 4;
      words[i] = (bytes[j] << 24) | (bytes[j + 1] << 16) | (bytes[j + 2] << 8) | bytes[j + 3];
    }
  }

  function makeJob(prefixStr) {
    const prefix = new TextEncoder().encode(prefixStr);
    const fixedBlocks = Math.floor(prefix.length / 64);
    const mid = new Int32Array(IV);
    const blockWords = new Int32Array(16);
    for (let b = 0; b < fixedBlocks; b++) {
      toWords(prefix.subarray(b * 64, b * 64 + 64), blockWords, 0, 15);
      compress(mid, blockWords, 0, mid);
    }
    return { prefixLen: prefix.length, mid, rest: prefix.slice(fixedBlocks * 64) };
  }

  function layout(job, nd) {
    const r = job.rest.length, end = r + nd;
    const nBlocks = Math.ceil((end + 9) / 64);
    const bytes = new Uint8Array(nBlocks * 64);
    bytes.set(job.rest);
    bytes[end] = 0x80;
    const bits = (job.prefixLen + nd) * 8;
    const n = bytes.length;
    bytes[n - 4] = bits >>> 24; bytes[n - 3] = (bits >>> 16) & 255; bytes[n - 2] = (bits >>> 8) & 255; bytes[n - 1] = bits & 255;
    const words = new Int32Array(nBlocks * 16);
    toWords(bytes, words, 0, words.length - 1);
    Object.assign(job, { nd, bytes, words, nBlocks, wFrom: r >> 2, wTo: (end - 1) >> 2, nextPow: Math.pow(10, nd) });
  }

  const channel = new MessageChannel();
  let wake = null;
  channel.port1.onmessage = () => { const w = wake; wake = null; if (w) w(); };
  const yieldNow = () => new Promise((r) => { wake = r; channel.port2.postMessage(0); });

  let token = 0;

  async function run(m, myToken) {
    const job = makeJob(m.prefix);
    const stride = m.stride, target = m.target, r = job.rest.length;
    let nonce = m.start;
    layout(job, String(nonce).length);
    let counted = 0;
    for (;;) {
      const until = performance.now() + 40;
      let found = false;
      do {
        for (let k = 0; k < 2048; k++) {
          if (nonce >= job.nextPow) layout(job, String(nonce).length);
          const bytes = job.bytes, words = job.words;
          let v = nonce;
          for (let p = r + job.nd - 1; p >= r; p--) { const q = Math.floor(v / 10); bytes[p] = 48 + (v - q * 10); v = q; }
          toWords(bytes, words, job.wFrom, job.wTo);
          compress(job.mid, words, 0, out);
          for (let b = 1; b < job.nBlocks; b++) compress(out, words, b * 16, out);
          counted++;
          if ((out[0] >>> 0) < target) { found = true; break; }   // first 32 bits below the target
          nonce += stride;
        }
      } while (!found && performance.now() < until);

      if (found) {
        let hex = "";
        for (let i = 0; i < 8; i++) hex += (out[i] >>> 0).toString(16).padStart(8, "0");
        postMessage({ type: "found", jobId: m.jobId, nonce, hash: hex, hashes: counted });
        return;
      }
      postMessage({ type: "progress", jobId: m.jobId, hashes: counted });
      counted = 0;
      await yieldNow();
      if (myToken !== token) return;
    }
  }

  self.onmessage = (e) => {
    token++;
    if (e.data.type === "mine") run(e.data, token);
  };
}

const pool = { workers: null, failed: false, jobId: 0, job: null };

function startPool() {
  if (pool.workers) return true;
  if (pool.failed) return false;
  try {
    const url = URL.createObjectURL(new Blob([`(${minerWorkerMain.toString()})();`], { type: "text/javascript" }));
    pool.workers = Array.from({ length: THREADS }, () => {
      const w = new Worker(url);
      w.onmessage = onWorkerMessage;
      w.onerror = onWorkerError;
      return w;
    });
    return true;
  } catch (err) {
    console.warn("Web Workers unavailable — mining on one thread instead.", err);
    pool.failed = true;
    showTarget();
    return false;
  }
}

function stopPool() {
  if (pool.workers) pool.workers.forEach((w) => w.terminate());
  pool.workers = null;
  pool.job = null;
}

// Stop the current search (Stop, sign-out, or someone else found the block). Resolves it with null.
function abortMining() {
  const job = pool.job;
  if (job) {
    pool.job = null;
    if (pool.workers) pool.workers.forEach((w) => w.postMessage({ type: "idle" }));
    job.resolve(null);
  }
}

function onWorkerError(err) {
  console.warn("Mining worker failed — falling back to one thread.", err);
  const job = pool.job;
  stopPool();
  pool.failed = true;
  showTarget();
  if (job) job.resolve(undefined);
}

function paintProgress(job, hashes, t0) {
  const secs = (performance.now() - t0) / 1000;
  state.progress = hashes / job.work;
  $("mineMeta").textContent =
    `Mining block #${job.height}… ${fmtBig(hashes)} hashes tried (${Math.round(state.progress * 100)}% of the average) · ` +
    `${fmtRate(hashes / Math.max(secs, 0.001))}${pool.failed ? " on 1 thread" : ` on ${THREADS} threads`}`;
  $("blockBar").style.width = Math.min(100, state.progress * 100) + "%";
}

async function onWorkerMessage(e) {
  const m = e.data, job = pool.job;
  if (!job || m.jobId !== job.jobId) return;
  job.hashes += m.hashes;

  if (m.type === "progress") {
    const now = performance.now();
    if (now - job.lastPaint > 250) { job.lastPaint = now; paintProgress(job, job.hashes, job.t0); }
    return;
  }

  pool.job = null;
  pool.workers.forEach((w) => w.postMessage({ type: "idle" }));
  const ms = performance.now() - job.t0;
  const hash = await sha256Hex(job.prefix + m.nonce);
  if (hash !== m.hash || !meetsTarget(hash, job.target)) {
    console.error("Worker hash failed verification — switching to one-thread mining.", m, hash);
    stopPool();
    pool.failed = true;
    showTarget();
    job.resolve(undefined);
    return;
  }
  job.resolve({ ...job.block, nonce: m.nonce, hash, attempts: Math.max(job.hashes, m.nonce + 1), ms });
}

// Resolves to the solved block, null if stopped or beaten, or undefined if workers are unavailable.
function mineParallel(job) {
  if (!startPool()) return Promise.resolve(undefined);
  const jobId = ++pool.jobId;
  return new Promise((resolve) => {
    pool.job = { ...job, block: job, jobId, resolve, hashes: 0, t0: performance.now(), lastPaint: 0 };
    pool.workers.forEach((w, i) =>
      w.postMessage({ type: "mine", jobId, prefix: job.prefix, target: job.target, start: i, stride: pool.workers.length }));
  });
}

// Single-thread fallback with the browser's own SHA-256.
async function mineSingle(job, session) {
  const t0 = performance.now();
  for (let nonce = 0; ; nonce++) {
    const hash = await sha256Hex(job.prefix + nonce);
    if (meetsTarget(hash, job.target)) return { ...job, nonce, hash, attempts: nonce + 1, ms: performance.now() - t0 };
    if (nonce % 2000 === 1999) {
      if (!state.running || session !== state.session || tipHash() !== job.prevHash) return null;
      paintProgress(job, nonce + 1, t0);
      await sleep(0);
    }
  }
}

/* ---------- 5. Mining loop + saving blocks ---------- */
const tradesCol = (asset = "PI") => db.collection("market").doc(asset).collection("trades");
// One line per trade in the block's trade fingerprint (txRoot). Trades from every market go in.
const tradeLine = (t) => `${t.asset}|${t.id}|${t.buyer}|${t.seller}|${t.qty}|${t.price}`;
const marketsList = () => ["PI", ...state.tickers];

// Take the tip and the waiting trades, and build the header to search on.
async function prepareJob() {
  const tip = state.tip;
  let trades = [];
  for (const asset of marketsList()) {
    if (trades.length >= MAX_BLOCK_TRADES) break;
    const snap = await tradesCol(asset).where("block", "==", null).limit(MAX_BLOCK_TRADES - trades.length).get();
    trades.push(...snap.docs.map((d) => ({ ...d.data({ serverTimestamps: "estimate" }), id: d.id, asset })));
  }
  trades = trades.sort((a, b) => tsMs(a.at) - tsMs(b.at) || (a.id < b.id ? -1 : 1)).slice(0, MAX_BLOCK_TRADES);
  const height = tip.height + 1;
  const b = {
    height, prevHash: tip.hash, prevTimestamp: tip.timestamp || 0, timestamp: Date.now(),
    miner: state.user.uid, reward: rewardAt(height), work: clampWork(tip.nextWork || START_WORK),
    txIds: trades.map((t) => `${t.asset}/${t.id}`), txRoot: await sha256Hex(trades.map(tradeLine).join("\n"))
  };
  return { ...b, prefix: blockHeader(b), target: targetFor(b.work) };
}

// Save a solved block — only if it still extends the tip. Returns { lost } or throws.
async function submitBlock(b) {
  const metaRef = db.collection("meta").doc("chain");
  const feesRef = db.collection("meta").doc("fees");      // Pi fees waiting for the next block
  const userRef = db.collection("users").doc(b.miner);
  const now = firebase.firestore.FieldValue.serverTimestamp();
  const minerName = (state.user.displayName || "Anonymous Miner").slice(0, 40);
  return db.runTransaction(async (tx) => {
    const meta = await tx.get(metaRef);
    const m = meta.exists ? meta.data() : null;
    if ((m ? m.hash : GENESIS_HASH) !== b.prevHash) {
      // Someone else got there first: hand back their tip so we can move on straight away
      return {
        lost: true, by: m && m.minerName,
        tip: m && { height: m.height, hash: m.hash, timestamp: m.timestamp, nextWork: m.nextWork, supply: m.supply || 0, minerName: m.minerName }
      };
    }
    const me = (await tx.get(userRef)).data() || {};
    const feeSnap = await tx.get(feesRef);
    const fees = feeSnap.exists ? feeSnap.data().pool || 0 : 0;
    const tip = {
      height: b.height, hash: b.hash, timestamp: b.timestamp, minerName,
      nextWork: nextWork(b.work, b.prevTimestamp, b.timestamp),
      supply: (m ? m.supply || 0 : 0) + b.reward
    };

    tx.set(db.collection("chain").doc(String(b.height)), {
      height: b.height, hash: b.hash, prevHash: b.prevHash, timestamp: b.timestamp,
      miner: b.miner, minerName, nonce: b.nonce, reward: b.reward, fees, work: b.work,
      txRoot: b.txRoot, txIds: b.txIds, at: now
    });
    if (fees) tx.set(feesRef, { pool: 0 });
    tx.set(metaRef, { ...tip, at: now });
    for (const key of b.txIds) {
      const [asset, id] = key.split("/");
      tx.update(tradesCol(asset).doc(id), { block: b.height });
    }
    // The miner gets the block reward (new Pi) plus every fee paid since the last block (existing Pi)
    tx.update(userRef, { coins: (me.coins || 0) + b.reward + fees, blocksMined: (me.blocksMined || 0) + 1 });
    tx.set(userRef.collection("history").doc(`block-${b.height}`), {
      kind: "block", height: b.height, reward: b.reward, fees, trades: b.txIds.length, at: now
    });
    return { lost: false, tip, fees };
  });
}

// Adopt a newer tip (from the live listener or our own saved block). Never step backwards.
function setTip(tip) {
  if (state.tipLoaded && tip.height < state.tip.height) return false;
  state.tip = tip;
  state.tipLoaded = true;
  if (pool.job && pool.job.prevHash !== tip.hash) abortMining();   // someone else's block: drop the search
  return true;
}

function onToggleClick() {
  if (!state.user) return;
  if (state.running) {
    state.running = false;
    abortMining();
    $("mineMeta").textContent = "Press Start to mine. You'll race everyone else for each block.";
    if (!state.submitting) setStatus("Miner stopped.", "");
    render();
    return;
  }
  state.running = true;
  setStatus("", "");
  render();
  if (!state.loopActive) runMiner();
}

async function runMiner() {
  const session = state.session;
  state.loopActive = true;
  render();
  try {
    while (state.running && session === state.session) {
      if (!state.tipLoaded) { await sleep(300); continue; }
      const job = await prepareJob();
      if (session !== state.session || !state.running) break;
      if (job.prevHash !== tipHash()) continue;              // a block landed while we were preparing

      state.mining = true;
      state.progress = 0;
      render();
      let block = await mineParallel(job);
      if (block === undefined && state.running && session === state.session) block = await mineSingle(job, session);
      state.mining = false;
      if (session !== state.session) return;
      if (!block) {
        if (!state.running) break;
        setStatus(`${state.tip.minerName || "Another miner"} found block #${job.height} first. Now mining #${job.height + 1}.`, "info");
        continue;
      }

      state.submitting = true;
      render();
      let result;
      try { result = await submitBlock(block); }
      catch (err) {
        setStatus(`Couldn't save block #${block.height}: ${dbErrorMessage(err)}`, "err");
        state.running = false;
        break;
      } finally { state.submitting = false; }
      if (session !== state.session) return;

      if (result.lost) {
        if (result.tip) setTip(result.tip);
        setStatus(`${result.by || "Another miner"} saved block #${block.height} a moment before you. Now mining #${block.height + 1}.`, "info");
      } else {
        setTip(result.tip);                    // build on our own block right away, without waiting for the listener
        const n = block.txIds.length;
        setStatus(`✓ You mined block #${block.height}: +${block.reward} Pi${result.fees ? ` + ${result.fees} Pi in fees` : ""}${n ? ` and confirmed ${n} trade${n === 1 ? "" : "s"}` : ""}.`, "ok");
        $("mineMeta").textContent =
          `Block #${block.height} solved · nonce ${block.nonce.toLocaleString()} · ${fmtBig(block.attempts)} hashes · ${fmtTime(block.ms)}`;
      }
    }
  } finally {
    if (session === state.session) {
      state.loopActive = false;
      state.mining = false;
      render();
    }
  }
}

/* ---------- 6. Checking blocks other players mined ---------- */
async function verifyBlocks() {
  const byHeight = new Map(state.blocks.map((b) => [b.height, b]));
  let changed = false;
  for (const b of state.blocks) {
    if (state.checked.has(b.hash)) continue;
    const hash = await sha256Hex(blockHeader(b) + b.nonce);
    const prev = byHeight.get(b.height - 1);
    const linked = b.height === 1 ? b.prevHash === GENESIS_HASH : !prev || prev.hash === b.prevHash;
    state.checked.set(b.hash, hash === b.hash && meetsTarget(hash, targetFor(b.work)) && linked);
    changed = true;
  }
  if (changed) renderChain();
}

/* ---------- 7. Rendering ---------- */
function setStatus(text, kind) {
  const s = $("status");
  s.textContent = text;
  s.className = "status" + (kind ? " " + kind : "");
}

function showTarget() {
  const work = clampWork(state.tip.nextWork || START_WORK);
  $("mineTarget").replaceChildren(
    document.createTextNode("Target: a SHA-256 hash below "),
    el("code", null, targetFor(work).toString(16).padStart(8, "0") + "…"),
    document.createTextNode(pool.failed ? " · 1 CPU thread" : ` · ${THREADS} CPU threads`)
  );
}

function render() {
  const h = state.tip.height + 1;
  const work = clampWork(state.tip.nextWork || START_WORK);
  $("nextHeight").textContent = state.tipLoaded ? `#${h.toLocaleString()}` : "…";
  $("nextSub").textContent = state.tipLoaded
    ? `Reward ${rewardAt(h)} Pi${state.feePool ? ` + ${state.feePool.toLocaleString()} Pi in fees` : ""} · ${state.pending}${state.pending >= MAX_BLOCK_TRADES ? "+" : ""} trade${state.pending === 1 ? "" : "s"} waiting to be confirmed`
    : "Loading the chain…";
  $("workSub").textContent = `Difficulty: about ${fmtBig(work)} hashes per block, aiming for one block a minute`;
  if (!state.mining) $("blockBar").style.width = "0%";

  const w = state.wallet;
  $("cloudCoins").textContent = w.loaded ? w.coins.toLocaleString() : "…";
  $("cloudSub").textContent =
    `You've mined ${w.blocksMined.toLocaleString()} block${w.blocksMined === 1 ? "" : "s"} · ` +
    `${(state.tip.supply || 0).toLocaleString()} Pi mined by everyone so far`;

  const btn = $("mineBtn");
  btn.disabled = !state.user;
  btn.classList.toggle("running", state.running);
  btn.setAttribute("aria-pressed", String(state.running));
  $("mineLabel").textContent = state.running ? "Stop" : "Start";
  $("mineSub").textContent =
    state.running ? (state.submitting ? "saving block…" : "mining…")
    : state.loopActive || state.submitting ? "stopping…"
    : "mining is off";
  showTarget();
  renderChain();
}

function hashNode(hash) {
  const span = el("span", "hash");
  const zeros = hash.match(/^0*/)[0].length;
  span.append(el("span", "z", hash.slice(0, zeros)), document.createTextNode(hash.slice(zeros)));
  span.title = hash;
  return span;
}

function renderChain() {
  const box = $("chain");
  if (!state.blocks.length) {
    box.replaceChildren(el("div", "empty", state.tipLoaded ? "No blocks yet. Press Start to mine block #1." : "Loading the chain…"));
    return;
  }
  box.replaceChildren(...state.blocks.map((b) => {
    const card = el("div", "block");
    const head = el("div", "block-head");
    const left = el("span");
    const mine = state.user && b.miner === state.user.uid;
    const n = (b.txIds || []).length;
    left.append(el("b", null, `#${b.height}`),
      document.createTextNode(`  ${mine ? "you" : b.minerName} · +${b.reward + (b.fees || 0)} Pi${b.fees ? ` (${b.fees} in fees)` : ""} · ${n} trade${n === 1 ? "" : "s"} · ${ago(tsMs(b.at))}`));
    const ok = state.checked.get(b.hash);
    const tag = ok === undefined ? el("span", "tag unsaved", "checking…")
      : ok ? el("span", "tag saved", "✓ verified") : el("span", "tag bad", "✗ doesn't add up");
    if (ok !== undefined) tag.title = ok ? "This page re-hashed the block and it checks out" : "The hash, target or link to the previous block is wrong";
    head.append(left, tag);
    const hl = el("div", "hash-line");
    hl.append(el("span", "k", "hash"), hashNode(b.hash));
    const pl = el("div", "hash-line");
    const prev = el("span", "hash", b.prevHash);
    prev.title = b.prevHash;
    pl.append(el("span", "k", "prev"), prev);
    card.append(head, hl, pl);
    return card;
  }));
}

function renderBoard(snap) {
  const box = $("board");
  box.replaceChildren();
  if (snap.empty) { box.append(el("div", "empty", "No one holds Pi coin yet. Mine the first block!")); return; }
  let rank = 0;
  snap.forEach((doc) => {
    const d = doc.data();
    if (!d.coins) return;
    rank++;
    const me = state.user && doc.id === state.user.uid;
    const row = el("div", "lb-row" + (me ? " me" : ""));
    row.append(
      el("span", "lb-rank", rank),
      el("span", "lb-name", (d.displayName || "Miner") + (me ? " (you)" : "")),
      el("span", "lb-coins", (d.coins || 0).toLocaleString())
    );
    box.append(row);
  });
  if (!rank) box.append(el("div", "empty", "No one holds Pi coin yet. Mine the first block!"));
}

function dbErrorMessage(err) {
  switch (err && err.code) {
    case "permission-denied":
      return "Firestore refused the request. Publish the latest firestore.rules in the Firebase console (Firestore → Rules).";
    case "unavailable":
      return "Can't reach Firestore. Check your connection.";
    case "failed-precondition":
      return "Firestore isn't set up for this project yet (create the database in the console).";
    default:
      return (err && err.message) || "Unknown error.";
  }
}

/* ---------- 8. Sign-in ---------- */
function showAuthError(err) {
  if (!err) return;
  const msg = {
    "auth/unauthorized-domain":
      `This domain (${location.hostname || "file://"}) isn't authorized. Add it under Firebase Console → Authentication → Settings → Authorized domains.`,
    "auth/operation-not-allowed": "Google sign-in isn't enabled. Turn it on under Authentication → Sign-in method.",
    "auth/network-request-failed": "Network error. Check your connection and try again."
  }[err.code];
  $("loginError").textContent = msg || err.message;
}

async function onLoginClick() {
  $("loginError").textContent = "";
  const provider = new firebase.auth.GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });
  try {
    await auth.signInWithPopup(provider);
  } catch (err) {
    if (err.code === "auth/popup-blocked" || err.code === "auth/operation-not-supported-in-this-environment") {
      return auth.signInWithRedirect(provider);
    }
    if (err.code !== "auth/popup-closed-by-user" && err.code !== "auth/cancelled-popup-request") showAuthError(err);
  }
}

function resetSession() {
  state.session++;
  abortMining();
  stopPool();
  unsubs.forEach((u) => u());
  unsubs = [];
  Object.assign(state, {
    running: false, loopActive: false, mining: false, submitting: false, progress: 0,
    pending: 0, pendingBy: new Map(), tickers: [],
    wallet: { coins: 0, blocksMined: 0, loaded: false }
  });
  $("mineMeta").textContent = "Press Start to mine. You'll race everyone else for each block.";
  setStatus("", "");
}

function handleAuth(user) {
  if (!user) {
    state.user = null;
    Economy.signOut();
    Companies.signOut();
    Factory.signOut();
    Contracts.signOut();
    Market.signOut();
    Work.signOut();
    Bank.signOut();
    resetSession();
    $("dashboard").classList.add("hidden");
    $("userChip").classList.add("hidden");
    $("loginView").classList.remove("hidden");
    return;
  }

  if (!state.user || state.user.uid !== user.uid) resetSession();
  state.user = user;
  $("loginView").classList.add("hidden");
  $("dashboard").classList.remove("hidden");
  $("userChip").classList.remove("hidden");
  $("userName").textContent = user.displayName || user.email || "Miner";
  const photo = $("userPhoto");
  if (user.photoURL) { photo.src = user.photoURL; photo.classList.remove("hidden"); }
  else photo.classList.add("hidden");

  Economy.signIn(user);                        // wallet, starting Cash, exchange
  Companies.signIn(user);                      // companies, shares, dividends
  Contracts.signIn(user);                      // supply contracts (before the factory opens one)
  Factory.signIn(user);                        // production
  Market.signIn(user);                         // goods marketplace
  Work.signIn(user);                           // day jobs and jobs at companies
  Bank.signIn(user);                           // deposits and loans
  const session = state.session;
  const live = (fn) => (...args) => { if (session === state.session) fn(...args); };
  const fail = (what) => live((err) => setStatus(`${what}: ${dbErrorMessage(err)}`, "err"));

  unsubs.push(db.collection("users").doc(user.uid).onSnapshot(live((snap) => {
    const d = snap.exists ? snap.data() : {};
    state.wallet = { coins: d.coins || 0, blocksMined: d.blocksMined || 0, loaded: true };
    render();
  }), fail("Wallet")));

  // The chain tip: when someone else lands a block, drop the current search and move on
  unsubs.push(db.collection("meta").doc("chain").onSnapshot(live((snap) => {
    const d = snap.exists ? snap.data() : null;
    setTip(d
      ? { height: d.height, hash: d.hash, timestamp: d.timestamp, nextWork: d.nextWork, supply: d.supply || 0, minerName: d.minerName }
      : { height: 0, hash: GENESIS_HASH, timestamp: 0, nextWork: START_WORK, supply: 0 });
    render();
  }), fail("Chain")));

  // Fees waiting for whoever mines the next block
  unsubs.push(db.collection("meta").doc("fees").onSnapshot(live((snap) => {
    state.feePool = snap.exists ? snap.data().pool || 0 : 0;
    render();
  }), () => {}));

  unsubs.push(db.collection("chain").orderBy("height", "desc").limit(CHAIN_SHOWN).onSnapshot(live((snap) => {
    state.blocks = snap.docs.map((d) => d.data({ serverTimestamps: "estimate" }));
    renderChain();
    verifyBlocks();
  }), fail("Blocks")));

  // Waiting trades, per market (Pi coin + every company)
  const pendingSubs = new Map();
  const watchPending = (asset) => {
    if (pendingSubs.has(asset)) return;
    const u = tradesCol(asset).where("block", "==", null).limit(MAX_BLOCK_TRADES).onSnapshot(live((snap) => {
      state.pendingBy.set(asset, snap.size);
      state.pending = [...state.pendingBy.values()].reduce((a, n) => a + n, 0);
      render();
    }), fail("Pending trades"));
    pendingSubs.set(asset, u);
    unsubs.push(u);
  };
  watchPending("PI");
  unsubs.push(db.collection("companies").orderBy("createdAt", "asc").limit(100).onSnapshot(live((snap) => {
    state.tickers = snap.docs.map((d) => d.id);
    state.tickers.forEach(watchPending);
  }), fail("Companies")));

  unsubs.push(db.collection("users").orderBy("coins", "desc").limit(10).onSnapshot(live(renderBoard),
    live((err) => $("board").replaceChildren(el("div", "empty", dbErrorMessage(err))))));

  render();
}

/* ---------- 9. Boot ---------- */
showTarget();
$("mineBtn").addEventListener("click", onToggleClick);
$("loginBtn").addEventListener("click", onLoginClick);
$("signOutBtn").addEventListener("click", () => auth.signOut());
setInterval(() => { if (state.user) renderChain(); }, 30000);   // keep "x min ago" fresh

if (typeof firebase === "undefined") {
  $("loginBtn").disabled = true;
  $("loginError").textContent = "Couldn't load the Firebase SDK. Check your internet connection.";
} else {
  firebase.initializeApp(firebaseConfig);
  auth = firebase.auth();
  db = firebase.firestore();
  Economy.init(firebase, db);
  Companies.init(firebase, db);
  Factory.init(firebase, db);
  Contracts.init(firebase, db);
  Market.init(firebase, db);
  Work.init(firebase, db);
  Bank.init(firebase, db);
  auth.getRedirectResult().catch(showAuthError);
  auth.onAuthStateChanged(handleAuth);
}
