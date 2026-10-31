// The orchestrator runs the workflow:
//   Production alert → [Metrics | Logs | Deployment] agents in parallel → Correlation agent
//   → request "Rollback service" action in Port (requires human approval)
//   → Port calls our webhook once approved → rollback → Verify agent → resolve incident
import express from "express";
import { createHmac, timingSafeEqual } from "node:crypto";
import { cfg, BP, ACTION_ID } from "../config.js";
import { appClient } from "../lib/appClient.js";
import { deployAndRecord } from "../lib/deploy.js";
import { port } from "../port/client.js";
import { log } from "../lib/log.js";
import { metricsAgent } from "../agents/metricsAgent.js";
import { logsAgent } from "../agents/logsAgent.js";
import { deploymentAgent } from "../agents/deploymentAgent.js";
import { correlationAgent } from "../agents/correlationAgent.js";
import { verifyAgent } from "../agents/verifyAgent.js";
import { live, setLive, setAgent, resetLive } from "../lib/live.js";
import { startControlRoom } from "../ui/server.js";

const service = cfg.service;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const incidents = new Map(); // incidentId → { suspectDeploymentId, baseline, timeline }
let busy = false;
let cooldownUntil = 0;

const md = (items) => items.filter(Boolean).map((x) => `- ${x}`).join("\n");
const AGENTS = ["Metrics Agent", "Logs Agent", "Deployment Agent", "Correlation Agent", "Verify Agent"];
const secondsBetween = (from, to) => (from && to ? Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 1000)) : undefined);
// Error rates arrive as fractions (0-1); the dashboard shows percentages.
const pct = (x) => (typeof x === "number" ? Math.round((x <= 1 ? x * 100 : x) * 100) / 100 : undefined);
const alertTypeOf = (title) => (title === "High error rate" || title === "High latency" ? title : "Manual");

// ── 1. Investigation: fan-out, correlate, request approval ──────────────
async function investigate(alert) {
  busy = true;
  const incidentId = `INC-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${String(Date.now()).slice(-4)}`;
  const timeline = [`${alert.at} — Alert: ${alert.summary}`];
  setLive({ stage: "alert", incidentId, alert: { ...alert }, verdict: null, approval: null, rollback: null, verify: null, resolved: null, error: null });
  for (const name of Object.keys(live.state.agents)) setAgent(name, { status: "idle", summary: null, lastTool: null });
  log.banner(`🚨 PRODUCTION ALERT · ${service}`, alert.summary);

  try {
    await port.upsertEntity(BP.incident, {
      identifier: incidentId,
      title: `${service}: ${alert.title}`,
      properties: {
        status: "Investigating", severity: "SEV2", alert: alert.summary, detectedAt: alert.at, agentTimeline: md(timeline),
        // Fields the Agentic Incident Response dashboard reads
        source: "Live demo", alertType: alertTypeOf(alert.title), agentsInvolved: AGENTS,
        aiModel: cfg.agentMode === "mock" ? "mock mode" : cfg.model,
        errorRateAtAlert: pct(alert.errorRate), p99AtAlert: alert.p99,
      },
      relations: { service },
    });
    await port.upsertEntity(BP.service, { identifier: service, properties: { health: "Degraded" } });
    log.port(`Opened incident ${incidentId}, marked ${service} as Degraded`);

    log.banner("Step 1 · Three specialist agents investigate in parallel");
    setLive({ stage: "investigating" });
    const track = (name, promise) => {
      setAgent(name, { status: "working" });
      return promise.then((r) => { setAgent(name, { status: "done", summary: r?.summary }); return r; });
    };
    const [metrics, logs, deployment] = await Promise.all([
      track("Metrics Agent", metricsAgent({ service, alert })),
      track("Logs Agent", logsAgent({ service, alert })),
      track("Deployment Agent", deploymentAgent({ service, alert })),
    ]);
    timeline.push(`Metrics Agent — ${metrics.summary}`, `Logs Agent — ${logs.summary}`, `Deployment Agent — ${deployment.summary}`);
    await port.upsertEntity(BP.incident, { identifier: incidentId, properties: { agentTimeline: md(timeline) } });

    log.banner("Step 2 · Correlation Agent builds the root cause");
    setLive({ stage: "correlating" });
    setAgent("Correlation Agent", { status: "working" });
    const verdict = await correlationAgent({ service, alert, metrics, logs, deployment });
    setAgent("Correlation Agent", { status: "done", summary: verdict.summary });
    timeline.push(`Correlation Agent — ${verdict.summary} (confidence ${Math.round(verdict.confidence * 100)}%)`);
    const action = verdict.recommendedAction || {};
    const actionText = action.type === "rollback" ? `Rollback ${service} to v${action.targetVersion}` : "Escalate to owning team";

    const evidence = [
      "**Evidence**", md(verdict.evidence || []),
      "", "**Timeline**", md(verdict.timeline || []),
      "", "**Ruled out**", md(verdict.ruledOut || []),
    ].join("\n");

    await port.upsertEntity(BP.incident, {
      identifier: incidentId,
      properties: {
        status: action.type === "rollback" ? "Awaiting approval" : "Escalated",
        rootCause: verdict.rootCause,
        confidence: verdict.confidence,
        recommendedAction: actionText,
        evidence,
        agentTimeline: md(timeline),
        category: action.type === "rollback" ? "Bad deployment" : "Unknown",
        timeToDetectSeconds: secondsBetween(deployment.recentChange?.deployedAt, alert.at),
      },
      relations: { service, ...(verdict.suspectDeploymentId ? { suspectDeployment: verdict.suspectDeploymentId } : {}) },
    });
    incidents.set(incidentId, { suspectDeploymentId: verdict.suspectDeploymentId, baseline: metrics.baseline, timeline, detectedAt: alert.at });

    setLive({
      verdict: {
        rootCause: verdict.rootCause, confidence: verdict.confidence, evidence: verdict.evidence || [],
        ruledOut: verdict.ruledOut || [], actionText, actionType: action.type, targetVersion: action.targetVersion,
        owner: deployment.owner || null, suspectVersion: deployment.recentChange?.version, suspectBy: deployment.recentChange?.deployedBy,
      },
    });
    log.info(`${log.C.bold}Root cause:${log.C.reset} ${verdict.rootCause}`);
    log.info(`${log.C.bold}Recommended:${log.C.reset} ${actionText}`);

    if (action.type !== "rollback") {
      await port.upsertEntity(BP.incident, { identifier: incidentId, properties: { resolution: "Escalated to owner" } });
      setLive({ stage: "escalated" });
      log.warn(`No safe automated action. Escalate to ${deployment.owner?.team} (${deployment.owner?.slackChannel}).`);
      busy = false;
      return;
    }

    log.banner("Step 3 · Human approval", "Agents can request a rollback. Only a human can approve it.");
    const approvalRequestedAt = new Date().toISOString();
    incidents.get(incidentId).approvalRequestedAt = approvalRequestedAt;
    const run = await port.runAction(ACTION_ID, {
      entity: service,
      properties: {
        target_version: action.targetVersion,
        incident_id: incidentId,
        reason: `**${verdict.rootCause}**\n\nConfidence: ${Math.round(verdict.confidence * 100)}%\n\n${md(verdict.evidence || [])}`,
      },
    });
    await port.upsertEntity(BP.incident, {
      identifier: incidentId,
      properties: {
        approvalRequestedAt,
        rolledBackFrom: deployment.recentChange?.version,
        rolledBackTo: action.targetVersion,
        ...(run.id ? { rollbackRunId: run.id } : {}),
      },
    });
    setLive({
      stage: "approval",
      approval: { requestedAt: approvalRequestedAt, runId: run.id || null, runUrl: run.id ? `${cfg.port.appUrl}/organization/run?runId=${run.id}` : `${cfg.port.appUrl}/self-serve` },
    });
    log.port(`Requested "Rollback service" → v${action.targetVersion} (run ${run.id || "created"})`);
    log.port(`⏸  Waiting for approval. Owner: ${deployment.owner?.onCall}. Approve the run in Port: ${cfg.port.appUrl}`);
  } catch (err) {
    log.error(`Investigation failed: ${err.message}`);
    setLive({ stage: "error", error: `Investigation failed: ${err.message}` });
    busy = false;
  }
}

// ── 2. Approved rollback (called by Port) → verify → resolve ────────────
async function executeRollback({ runId, targetVersion, incidentId }) {
  log.banner("✅ Approved in Port · executing rollback");
  const approvedAt = new Date().toISOString();
  const state = incidents.get(incidentId) || {};
  if (incidentId && (!state.suspectDeploymentId || !state.detectedAt || !state.approvalRequestedAt)) {
    const inc = await port.getEntity(BP.incident, incidentId).catch(() => null);
    state.suspectDeploymentId ||= inc?.relations?.suspectDeployment || null;
    state.detectedAt ||= inc?.properties?.detectedAt;
    state.approvalRequestedAt ||= inc?.properties?.approvalRequestedAt;
  }
  const timeline = state.timeline || [];
  const approvedBy = await port.getRunApprover(runId).catch(() => null);
  setLive({
    stage: "rollback",
    incidentId: live.state.incidentId || incidentId,
    approval: { ...(live.state.approval || {}), runId, approvedAt, approvedBy, requestedAt: live.state.approval?.requestedAt || state.approvalRequestedAt },
  });

  try {
    await port.runLog(runId, `Approved. Rolling back ${service} to v${targetVersion}.`);
    if (incidentId) {
      await port.upsertEntity(BP.incident, {
        identifier: incidentId,
        properties: {
          status: "Mitigating", approvedAt, rollbackRunId: runId,
          timeToApproveSeconds: secondsBetween(state.approvalRequestedAt, approvedAt),
          ...(approvedBy ? { approvedBy } : {}),
        },
      }, { runId });
    }

    const d = await deployAndRecord({ version: targetVersion, by: "incident-agents (approved in Port)", kind: "rollback", runId, rolledBackDeploymentId: state.suspectDeploymentId });
    const rollbackAt = d.deployedAt;
    log.ok(`Rolled back ${service} to v${targetVersion}`);
    timeline.push(`${rollbackAt} — Rollback to v${targetVersion} executed after human approval`);
    await port.runLog(runId, `Rollback deployed (${d.identifier}). Verifying recovery for ${cfg.verifyWaitSeconds}s…`);

    setLive({ stage: "verifying", rollback: { version: targetVersion, at: rollbackAt }, verify: { waitSeconds: cfg.verifyWaitSeconds, startedAt: new Date().toISOString() } });
    log.banner("Step 4 · Verify recovery", `Waiting ${cfg.verifyWaitSeconds}s for fresh metrics`);
    await sleep(cfg.verifyWaitSeconds * 1000);
    setAgent("Verify Agent", { status: "working" });
    const check = await verifyAgent({ service, rollbackAt, baseline: state.baseline });
    setAgent("Verify Agent", { status: "done", summary: check.summary });
    timeline.push(`Verify Agent — ${check.summary}`);

    if (check.recovered) {
      const resolvedAt = new Date().toISOString();
      await port.upsertEntity(BP.incident, {
        identifier: incidentId,
        properties: {
          status: "Resolved", resolvedAt, agentTimeline: md(timeline), resolution: "Rolled back",
          timeToRecoverSeconds: secondsBetween(state.detectedAt, resolvedAt),
          errorRateAfter: pct(check.after?.errorRate), p99After: check.after?.p99,
        },
      }, { runId });
      await port.upsertEntity(BP.service, { identifier: service, properties: { health: "Healthy" } }, { runId });
      await port.runLog(runId, `Recovery verified: ${check.summary}`, { terminationStatus: "SUCCESS", statusLabel: "Recovered" });
      setLive({
        stage: "resolved",
        resolved: {
          at: resolvedAt, summary: check.summary,
          timeToRecoverSeconds: secondsBetween(state.detectedAt, resolvedAt),
          timeToApproveSeconds: secondsBetween(state.approvalRequestedAt, approvedAt),
          errorRateAfter: pct(check.after?.errorRate), p99After: check.after?.p99,
        },
      });
      log.banner(`🎉 ${incidentId} resolved`, check.summary);
    } else {
      await port.upsertEntity(BP.incident, {
        identifier: incidentId,
        properties: {
          status: "Escalated", agentTimeline: md(timeline), resolution: "Escalated to owner",
          errorRateAfter: pct(check.after?.errorRate), p99After: check.after?.p99,
        },
      }, { runId });
      await port.runLog(runId, `Recovery NOT verified: ${check.summary}`, { terminationStatus: "FAILURE", statusLabel: "Not recovered, escalated" });
      setLive({ stage: "escalated" });
      log.error(`Not recovered. ${check.summary} Escalating to the owning team.`);
    }
  } catch (err) {
    log.error(`Rollback failed: ${err.message}`);
    setLive({ stage: "error", error: `Rollback failed: ${err.message}` });
    await port.runLog(runId, `Rollback failed: ${err.message}`, { terminationStatus: "FAILURE", statusLabel: "Failed" }).catch(() => {});
  } finally {
    busy = false;
    cooldownUntil = Date.now() + 60_000;
  }
}

// ── 3. Webhook server for Port ───────────────────────────────────────────
// Returns null when the request is genuinely from Port, otherwise the reason it isn't.
function signatureProblem(req) {
  const sig = req.get("x-port-signature");
  const ts = req.get("x-port-timestamp");
  if (!sig || !ts) return "missing x-port-signature / x-port-timestamp headers";
  const expected = createHmac("sha256", cfg.port.clientSecret || "").update(`${ts}.${req.rawBody}`).digest("base64");
  const given = sig.split(",")[1] || "";
  const matches = given.length === expected.length && timingSafeEqual(Buffer.from(given), Buffer.from(expected));
  if (!matches) return "signature mismatch: PORT_CLIENT_SECRET in .env must belong to the Port org sending the webhook";
  // Replay protection. Port can stamp the payload when the run is created, and a human
  // approval can take a while, so allow up to 24 hours rather than a few minutes.
  const tsSeconds = Number(ts) > 1e12 ? Number(ts) / 1000 : Number(ts);
  const ageSeconds = Date.now() / 1000 - tsSeconds;
  if (ageSeconds > 24 * 3600) return `timestamp too old (${Math.round(ageSeconds)}s)`;
  return null;
}

const server = express();
server.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf.toString("utf8"); } }));
server.get("/health", (_req, res) => res.json({ ok: true, busy }));
server.post("/port/webhook", (req, res) => {
  if (cfg.verifySignature) {
    const problem = signatureProblem(req);
    if (problem) {
      log.warn(`Rejected webhook: ${problem}`);
      return res.status(401).json({ error: problem });
    }
  }
  const { runId, targetVersion, incidentId } = req.body || {};
  if (!runId || !targetVersion) return res.status(400).json({ error: "runId and targetVersion are required" });
  res.status(202).json({ accepted: true }); // async: we report the result via the run logs API
  executeRollback({ runId, targetVersion, incidentId });
});

// ── 4. Alert watcher ─────────────────────────────────────────────────────
let breaches = 0;
async function watch() {
  if (busy || Date.now() < cooldownUntil) return;
  try {
    const m = await appClient.metrics(60, 15);
    const c = m.current30s;
    const breached = c.requests >= 20 && (c.errorRate > cfg.alertErrorRate || c.p99 > cfg.alertP99Ms);
    breaches = breached ? breaches + 1 : 0;
    if (breaches >= 2) {
      breaches = 0;
      investigate({
        title: c.errorRate > cfg.alertErrorRate ? "High error rate" : "High latency",
        summary: `${service}: error rate ${(c.errorRate * 100).toFixed(1)}% (threshold ${cfg.alertErrorRate * 100}%), p99 ${c.p99}ms over the last 30s`,
        at: new Date().toISOString(),
        errorRate: c.errorRate,
        p99: c.p99,
      });
    }
  } catch (err) {
    log.warn(`Watcher: ${err.message}`);
  }
}

// The control room's "Reset demo" button: clear this process's state too, so no restart is needed.
function resetOrchestrator() {
  busy = false;
  cooldownUntil = 0;
  breaches = 0;
  incidents.clear();
  resetLive();
}

server.listen(cfg.orchestratorPort, () => {
  startControlRoom({ isBusy: () => busy, resetOrchestrator, prepareForRelease: () => { cooldownUntil = 0; breaches = 0; } });
  log.banner("Incident agents online", `Agents: ${cfg.agentMode === "mock" ? "mock mode (no LLM)" : cfg.model} · webhook :${cfg.orchestratorPort}/port/webhook`);
  if (process.argv.includes("--investigate-now")) {
    investigate({ title: "Manual investigation", summary: `${service}: manual investigation requested`, at: new Date().toISOString() });
  } else {
    log.info(`Watching ${service}: alert on error rate > ${cfg.alertErrorRate * 100}% or p99 > ${cfg.alertP99Ms}ms`);
    setInterval(watch, 5000);
  }
});
