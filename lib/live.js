// What the control room shows: the current incident's progress plus a feed of
// everything the agents say. Lives inside the orchestrator process.
import { log } from "./log.js";

const AGENT_NAMES = ["Metrics Agent", "Logs Agent", "Deployment Agent", "Correlation Agent", "Verify Agent"];
const MAX_EVENTS = 400;

const blank = () => ({
  stage: "idle", // idle → alert → investigating → correlating → approval → rollback → verifying → resolved | escalated | error
  incidentId: null,
  alert: null,
  verdict: null,
  approval: null,
  rollback: null,
  verify: null,
  resolved: null,
  error: null,
  agents: Object.fromEntries(AGENT_NAMES.map((n) => [n, { status: "idle" }])),
});

export const live = { state: blank(), events: [], seq: 0, epoch: 1, lastDeploy: null };

export function setLive(patch) { Object.assign(live.state, patch); }
export function setAgent(name, patch) { live.state.agents[name] = { ...live.state.agents[name], ...patch }; }
export function pushEvent(ev) {
  live.events.push({ id: ++live.seq, t: new Date().toISOString(), ...ev });
  if (live.events.length > MAX_EVENTS) live.events.splice(0, live.events.length - MAX_EVENTS);
}
export function resetLive() { live.state = blank(); live.events = []; live.lastDeploy = null; live.epoch++; }
// A new release after a finished incident: clear the incident but keep the activity feed.
export function clearIncident() { live.state = blank(); }

// Mark agents as working when they call a tool, and done when they report.
log.onEvent((ev) => {
  pushEvent(ev);
  if (ev.agent && live.state.agents[ev.agent]) {
    if (ev.kind === "tool" && live.state.agents[ev.agent].status !== "done") setAgent(ev.agent, { status: "working", lastTool: ev.text });
    if (ev.kind === "result") setAgent(ev.agent, { status: "done", summary: ev.text });
  }
});
