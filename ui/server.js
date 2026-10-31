// Control room: a local page that runs the whole demo from the browser.
// Served by the orchestrator process on http://localhost:5050 and bound to 127.0.0.1,
// so it is never exposed through the tunnel that Port uses to reach the webhook.
import express from "express";
import { readFile } from "node:fs/promises";
import { cfg, BP } from "../config.js";
import { RELEASES, GOOD_VERSION } from "../app/releases.js";
import { deployAndRecord } from "../lib/deploy.js";
import { resetDemo } from "../lib/reset.js";
import { live, clearIncident } from "../lib/live.js";
import { log } from "../lib/log.js";

const KEEP_SAMPLES = 240; // seconds of traffic history kept for the chart
const ACTIVE = ["alert", "investigating", "correlating", "approval", "rollback", "verifying"];
const samples = [];
const markers = [];
let liveVersion = null;
let tunnel = { state: cfg.publicWebhookUrl ? "checking" : "missing" };

// ── Traffic sampler: one reading per second from the app ──────────────────
async function sample() {
  try {
    const r = await fetch(`${cfg.appUrl}/internal/live`, { signal: AbortSignal.timeout(900) }).then((x) => x.json());
    samples.push({ t: Date.now(), rps: r.rps, errorRate: r.errorRate, p99: r.p99, version: r.version, pool: r.pool });
    if (liveVersion && r.version !== liveVersion) {
      const isRollback = ["rollback", "verifying"].includes(live.state.stage);
      const who = live.lastDeploy?.version === r.version ? live.lastDeploy.name : null;
      markers.push({
        t: Date.now(), kind: isRollback ? "rollback" : "release",
        label: isRollback ? `Rollback to v${r.version}` : `v${r.version}${who ? ` by ${who}` : ""}`,
      });
    }
    liveVersion = r.version;
  } catch {
    samples.push({ t: Date.now(), down: true });
  }
  while (samples.length > KEEP_SAMPLES) samples.shift();
  while (markers.length && markers[0].t < (samples[0]?.t || 0)) markers.shift();
}

// ── Can Port reach the webhook? (ngrok / cloudflared tunnel check) ────────
async function checkTunnel() {
  if (!cfg.publicWebhookUrl) return (tunnel = { state: "missing" });
  const base = cfg.publicWebhookUrl.replace(/\/port\/webhook$/, "");
  try {
    const r = await fetch(`${base}/health`, { headers: { "ngrok-skip-browser-warning": "1" }, signal: AbortSignal.timeout(5000) });
    const body = await r.json().catch(() => ({}));
    tunnel = { state: r.ok && body.ok ? "ok" : "down", url: base };
  } catch {
    tunnel = { state: "down", url: base };
  }
}

export function startControlRoom({ isBusy, resetOrchestrator, prepareForRelease }) {
  const app = express();
  app.use(express.json());

  app.get("/", async (_req, res) => {
    res.set("Cache-Control", "no-store").type("html").send(await readFile(new URL("./index.html", import.meta.url), "utf8"));
  });

  app.get("/api/state", (req, res) => {
    const after = Number(req.query.after) || 0;
    const id = live.state.incidentId;
    res.json({
      now: Date.now(),
      service: cfg.service,
      epoch: live.epoch,
      busy: isBusy(),
      state: live.state,
      lastDeploy: live.lastDeploy,
      events: live.events.filter((e) => e.id > after),
      lastEventId: live.seq,
      samples,
      markers,
      liveVersion,
      goodVersion: GOOD_VERSION,
      releases: Object.entries(RELEASES)
        .map(([version, r]) => ({ version, commit: r.commit, summary: r.summary }))
        .sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true })),
      people: cfg.people,
      thresholds: { errorRate: cfg.alertErrorRate, p99: cfg.alertP99Ms },
      verifyWaitSeconds: cfg.verifyWaitSeconds,
      agentMode: cfg.agentMode === "mock" ? "Mock mode, no LLM" : `Running on ${cfg.model}`,
      tunnel,
      links: {
        port: cfg.port.appUrl,
        dashboard: `${cfg.port.appUrl}/agentic_incident_response`,
        incident: id ? `${cfg.port.appUrl}/${BP.incident}Entity?identifier=${encodeURIComponent(id)}` : null,
      },
    });
  });

  app.post("/api/deploy", async (req, res) => {
    const { version, handle } = req.body || {};
    const person = cfg.people.find((p) => p.handle === handle) || { name: handle || "someone", handle: handle || "someone" };
    if (!RELEASES[version]) return res.status(400).json({ error: `There is no release v${version}.` });
    if (ACTIVE.includes(live.state.stage) || isBusy()) return res.status(409).json({ error: "An incident is in progress. Let it finish or reset the demo first." });
    if (version === liveVersion) return res.status(409).json({ error: `v${version} is already live.` });
    try {
      if (["resolved", "escalated", "error"].includes(live.state.stage)) clearIncident();
      prepareForRelease();
      live.lastDeploy = { version, by: person.handle, name: person.name, at: new Date().toISOString() };
      log.banner(`🚀 ${person.name} is deploying ${cfg.service} v${version}`, RELEASES[version].summary);
      const d = await deployAndRecord({ version, by: person.handle });
      live.lastDeploy.at = d.deployedAt;
      log.port(`Recorded deployment ${d.identifier} (by ${person.handle}) in the catalog`);
      res.json({ ok: true });
    } catch (err) {
      live.lastDeploy = null;
      log.error(`Deploy failed: ${err.message}`);
      res.status(500).json({ error: `Deploy failed: ${err.message}` });
    }
  });

  app.post("/api/reset", async (_req, res) => {
    try {
      resetOrchestrator();
      await resetDemo();
      markers.push({ t: Date.now(), kind: "reset", label: "Reset" });
      log.ok("Demo reset. Ready for the next take.");
      res.json({ ok: true });
    } catch (err) {
      log.error(`Reset failed: ${err.message}`);
      res.status(500).json({ error: `Reset failed: ${err.message}` });
    }
  });

  setInterval(sample, 1000);
  checkTunnel();
  setInterval(checkTunnel, 15_000);

  app.listen(cfg.uiPort, "127.0.0.1", () => {
    console.log(`\n${log.C.bold}${log.C.cyan}▶ Control room: http://localhost:${cfg.uiPort}${log.C.reset}\n`);
  });
}
