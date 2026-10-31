// payments-api: a tiny service whose behaviour depends on the deployed version.
// It exposes its own metrics and logs endpoints, standing in for an
// observability stack (Datadog, New Relic, Grafana…) in this demo.
import express from "express";
import { randomUUID } from "node:crypto";
import { cfg } from "../config.js";
import { RELEASES, GOOD_VERSION } from "./releases.js";

const QUERY_MS = [40, 90];       // simulated DB query time
const ACQUIRE_TIMEOUT_MS = 400;  // how long a request waits for a connection
const RETENTION_MS = 15 * 60_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.random() * (b - a);

// ── Simulated connection pool ───────────────────────────────────────────
class Pool {
  constructor(size) { this.size = size; this.inUse = 0; this.waiters = []; }
  resize(size) { this.size = size; this.#drain(); }
  acquire(timeoutMs) {
    return new Promise((resolve, reject) => {
      if (this.inUse < this.size) { this.inUse++; return resolve(); }
      const waiter = { resolve };
      waiter.timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        const err = new Error(
          `could not acquire connection from pool (max=${this.size}, in_use=${this.inUse}, waiting=${this.waiters.length}) after ${timeoutMs}ms`
        );
        err.code = "DB_POOL_TIMEOUT";
        reject(err);
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }
  release() { this.inUse--; this.#drain(); }
  #drain() {
    while (this.inUse < this.size && this.waiters.length) {
      const w = this.waiters.shift();
      clearTimeout(w.timer);
      this.inUse++;
      w.resolve();
    }
  }
}

// ── State ────────────────────────────────────────────────────────────────
let version = process.env.APP_START_VERSION || GOOD_VERSION;
const pool = new Pool(RELEASES[version].dbPoolSize);
const requests = [];  // { t, ms, status }
const logs = [];      // { ts, level, code, message, version }

function log(level, message, code) {
  logs.push({ ts: new Date().toISOString(), level, code: code || null, message, version });
  if (logs.length > 5000) logs.splice(0, logs.length - 5000);
}

// Drop old request records in one splice. (Shifting them one by one froze the
// service for ~200ms every 10s once 15 minutes of history had built up.)
setInterval(() => {
  const cutoff = Date.now() - RETENTION_MS;
  let i = 0;
  while (i < requests.length && requests[i].t < cutoff) i++;
  if (i) requests.splice(0, i);
}, 10_000);

// ── App ──────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

app.post("/pay", async (_req, res) => {
  const start = Date.now();
  const id = randomUUID().slice(0, 8);
  try {
    // Background noise: a rare upstream timeout, so the agents must tell
    // the real cause apart from normal low-level errors.
    if (Math.random() < 0.003) {
      const err = new Error("fraud-check responded after 2000ms");
      err.code = "FRAUD_CHECK_TIMEOUT";
      throw err;
    }
    await pool.acquire(ACQUIRE_TIMEOUT_MS);
    const waited = Date.now() - start;
    try { await sleep(rand(...QUERY_MS)); } finally { pool.release(); }
    if (waited > 200) log("warn", `Slow connection acquire: waited ${waited}ms for a DB connection (req ${id})`, "DB_POOL_SLOW");
    else if (Math.random() < 0.02) log("info", `Payment captured (req ${id})`, null);
    requests.push({ t: Date.now(), ms: Date.now() - start, status: 200 });
    res.json({ ok: true, id, version });
  } catch (err) {
    const status = err.code === "FRAUD_CHECK_TIMEOUT" ? 502 : 500;
    requests.push({ t: Date.now(), ms: Date.now() - start, status });
    const kind = err.code === "DB_POOL_TIMEOUT" ? "DBConnectionTimeout" : "UpstreamTimeout";
    log("error", `${kind}: ${err.message} (POST /pay, req ${id})`, err.code);
    res.status(status).json({ ok: false, error: err.code });
  }
});

app.get("/health", (_req, res) => res.json({ service: cfg.service, version, pool: { max: pool.size, inUse: pool.inUse, waiting: pool.waiters.length } }));

function pct(sorted, p) {
  if (!sorted.length) return 0;
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]);
}
function summarize(rows, seconds) {
  const lat = rows.map((r) => r.ms).sort((a, b) => a - b);
  const errors = rows.filter((r) => r.status >= 500).length;
  return {
    requests: rows.length,
    rps: +(rows.length / seconds).toFixed(1),
    errorRate: rows.length ? +(errors / rows.length).toFixed(4) : 0,
    p50: pct(lat, 50), p95: pct(lat, 95), p99: pct(lat, 99),
  };
}

// Time-bucketed metrics, like a dashboard query.
app.get("/internal/metrics", (req, res) => {
  const windowS = Math.min(900, Math.max(30, Number(req.query.window_seconds) || 600));
  const bucketS = Math.max(5, Number(req.query.bucket_seconds) || 15);
  const now = Date.now();
  const from = now - windowS * 1000;
  const buckets = [];
  for (let s = from; s < now; s += bucketS * 1000) {
    const rows = requests.filter((r) => r.t >= s && r.t < s + bucketS * 1000);
    buckets.push({ start: new Date(s).toISOString(), ...summarize(rows, bucketS) });
  }
  const last30 = requests.filter((r) => r.t >= now - 30_000);
  const out = { service: cfg.service, windowSeconds: windowS, bucketSeconds: bucketS, current30s: summarize(last30, 30), buckets };
  // Optional: summary of everything since a timestamp (e.g. since a rollback).
  if (req.query.since) {
    const sinceMs = Date.parse(req.query.since);
    if (!Number.isNaN(sinceMs)) {
      const rows = requests.filter((r) => r.t >= sinceMs);
      out.sinceSummary = { since: new Date(sinceMs).toISOString(), ...summarize(rows, Math.max(1, (now - sinceMs) / 1000)) };
    }
  }
  res.json(out);
});

// Last few seconds only, for the control room's live chart. Scans from the newest record.
app.get("/internal/live", (_req, res) => {
  const seconds = 3;
  const cutoff = Date.now() - seconds * 1000;
  const rows = [];
  for (let i = requests.length - 1; i >= 0 && requests[i].t >= cutoff; i--) rows.push(requests[i]);
  res.json({ version, pool: { max: pool.size, inUse: pool.inUse, waiting: pool.waiters.length }, ...summarize(rows, seconds) });
});

// Log search, like a log platform query.
app.get("/internal/logs", (req, res) => {
  const level = req.query.level || "all";
  const sinceS = Number(req.query.since_seconds) || 600;
  const limit = Math.min(200, Number(req.query.limit) || 50);
  const q = (req.query.query || "").toString().toLowerCase();
  const cutoff = Date.now() - sinceS * 1000;
  const matched = logs.filter((l) =>
    Date.parse(l.ts) >= cutoff &&
    (level === "all" || l.level === level) &&
    (!q || l.message.toLowerCase().includes(q))
  );
  const countsByCode = {};
  for (const l of matched) if (l.code) countsByCode[l.code] = (countsByCode[l.code] || 0) + 1;
  res.json({ total: matched.length, countsByCode, firstSeen: matched[0]?.ts || null, entries: matched.slice(-limit) });
});

// Simulated deploy target. In real life this is your CD system.
app.post("/admin/deploy", (req, res) => {
  if (req.get("x-admin-token") !== cfg.adminToken) return res.status(401).json({ error: "bad admin token" });
  const target = req.body?.version;
  if (!RELEASES[target]) return res.status(400).json({ error: `unknown version ${target}`, known: Object.keys(RELEASES) });
  const previous = version;
  version = target;
  pool.resize(RELEASES[target].dbPoolSize);
  log("info", `Deployed ${cfg.service} v${target} (commit ${RELEASES[target].commit}), previous v${previous}`, "DEPLOY");
  log("info", `Database pool initialised: max_connections=${RELEASES[target].dbPoolSize}`, "DB_POOL_INIT");
  console.log(`\n\x1b[1m\x1b[35m⇪ Deployed v${target}\x1b[0m (was v${previous}) · pool max=${RELEASES[target].dbPoolSize}\n`);
  res.json({ ok: true, version: target, previous });
});

// Console heartbeat so the terminal tells the story on camera.
setInterval(() => {
  const s = summarize(requests.filter((r) => r.t >= Date.now() - 5000), 5);
  if (!s.requests) return;
  const bad = s.errorRate > cfg.alertErrorRate || s.p99 > cfg.alertP99Ms;
  const color = bad ? "\x1b[31m" : "\x1b[32m";
  console.log(`${color}[${cfg.service} v${version}]\x1b[0m ${s.rps} req/s · ${(s.errorRate * 100).toFixed(1)}% errors · p99 ${s.p99}ms · pool ${pool.inUse}/${pool.size} (waiting ${pool.waiters.length})`);
}, 5000);

app.listen(cfg.appPort, () => {
  log("info", `Service started v${version}`, "START");
  log("info", `Database pool initialised: max_connections=${pool.size}`, "DB_POOL_INIT");
  console.log(`${cfg.service} v${version} listening on http://localhost:${cfg.appPort}`);
});
