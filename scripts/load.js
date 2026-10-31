// npm run load — steady traffic against POST /pay with a live readout.
import { cfg } from "../config.js";

const CONCURRENCY = cfg.loadConcurrency;
const THINK_MS = 50;
let window = [];

async function worker() {
  for (;;) {
    const start = Date.now();
    let status = 0;
    try {
      const res = await fetch(`${cfg.appUrl}/pay`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ amount: 4200, currency: "USD" }) });
      status = res.status;
      await res.arrayBuffer();
    } catch { status = 0; }
    window.push({ ms: Date.now() - start, status });
    await new Promise((r) => setTimeout(r, THINK_MS));
  }
}

setInterval(() => {
  const rows = window; window = [];
  if (!rows.length) return console.log("\x1b[31mno responses (is the app running?)\x1b[0m");
  const errs = rows.filter((r) => r.status === 0 || r.status >= 500).length;
  const lat = rows.map((r) => r.ms).sort((a, b) => a - b);
  const p99 = lat[Math.min(lat.length - 1, Math.floor(lat.length * 0.99))];
  const rate = errs / rows.length;
  const color = rate > cfg.alertErrorRate || p99 > cfg.alertP99Ms ? "\x1b[31m" : "\x1b[32m";
  console.log(`${color}load\x1b[0m ${(rows.length / 2).toFixed(0)} req/s · ${(rate * 100).toFixed(1)}% errors · p99 ${p99}ms`);
}, 2000);

console.log(`Sending traffic to ${cfg.appUrl}/pay with ${CONCURRENCY} concurrent clients…`);
for (let i = 0; i < CONCURRENCY; i++) worker();
