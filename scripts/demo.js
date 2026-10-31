// npm run demo — starts payments-api, customer traffic and the incident agents together,
// then serves the control room at http://localhost:5050.
// Keep your tunnel running in another terminal (ngrok http 4000) so Port can reach the agents.
// Add --verbose to also see the app's and the load generator's heartbeat lines.
import { spawn } from "node:child_process";
import { cfg } from "../config.js";
import { log } from "../lib/log.js";

const verbose = process.argv.includes("--verbose");
const children = [];
let stopping = false;

const quiet = {
  app: (line) => /\[\S+ v[\d.]+\]/.test(line) && !verbose,   // per-5s heartbeat
  load: (line) => /^\S*load\S* \d/.test(line.replace(/\x1b\[[0-9;]*m/g, "")) && !verbose, // per-2s readout
  agents: () => false,
};
const label = { app: `${log.C.green}[app]${log.C.reset}`, load: `${log.C.gray}[load]${log.C.reset}`, agents: "" };

function start(name, file) {
  const child = spawn(process.execPath, [file], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  const pipe = (stream) => {
    let buf = "";
    stream.on("data", (chunk) => {
      buf += chunk;
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) if (!quiet[name](line)) console.log(label[name] ? `${label[name]} ${line}` : line);
    });
  };
  pipe(child.stdout);
  pipe(child.stderr);
  child.on("exit", (code) => {
    if (stopping) return;
    log.error(`${name} stopped (exit code ${code}). ${code === 1 ? "Is something else already using its port? Close any npm run app / agents terminals." : ""}`);
    stop(1);
  });
  children.push(child);
}

async function waitForApp() {
  for (let i = 0; i < 40; i++) {
    try { if ((await fetch(`${cfg.appUrl}/health`)).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`payments-api did not start on ${cfg.appUrl}`);
}

function stop(code = 0) {
  stopping = true;
  for (const c of children) c.kill("SIGTERM");
  setTimeout(() => process.exit(code), 300);
}
process.on("SIGINT", () => { console.log("\nStopping the demo…"); stop(0); });
process.on("SIGTERM", () => stop(0));

log.banner("Starting the agentic incident demo", "payments-api, customer traffic and the incident agents");
start("app", "app/server.js");
try {
  await waitForApp();
} catch (err) {
  log.error(err.message);
  stop(1);
}
start("load", "scripts/load.js");
start("agents", "orchestrator/index.js");
setTimeout(() => {
  if (stopping) return;
  console.log(`\n${log.C.bold}Open the control room: ${log.C.cyan}http://localhost:${cfg.uiPort}${log.C.reset}`);
  console.log(`${log.C.dim}Keep your tunnel running in another terminal (ngrok http ${cfg.orchestratorPort}) so Port can deliver approvals. Ctrl+C stops everything.${log.C.reset}\n`);
}, 1500);
