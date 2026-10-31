const C = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m",
  blue: "\x1b[34m", magenta: "\x1b[35m", cyan: "\x1b[36m", gray: "\x1b[90m",
};

const AGENT_COLORS = {
  "Metrics Agent": C.cyan,
  "Logs Agent": C.yellow,
  "Deployment Agent": C.magenta,
  "Correlation Agent": C.blue,
  "Verify Agent": C.green,
};

const short = (v, n = 140) => {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
};

// The control room subscribes here to show the same story in the browser.
const listeners = [];
const strip = (x) => String(x).replace(/\x1b\[[0-9;]*m/g, "");
const emit = (ev) => { for (const fn of listeners) { try { fn({ ...ev, text: strip(ev.text || "") }); } catch {} } };

export const log = {
  C,
  onEvent(fn) { listeners.push(fn); },
  banner(title, sub = "") {
    const line = "─".repeat(72);
    console.log(`\n${C.bold}${line}\n ${title}${C.reset}${sub ? `\n ${C.dim}${sub}${C.reset}` : ""}\n${C.bold}${line}${C.reset}`);
    emit({ kind: "stage", text: sub ? `${title}: ${strip(sub)}` : title });
  },
  info(msg) { console.log(`${C.gray}•${C.reset} ${msg}`); emit({ kind: "info", text: msg }); },
  ok(msg) { console.log(`${C.green}✔${C.reset} ${msg}`); emit({ kind: "ok", text: msg }); },
  warn(msg) { console.log(`${C.yellow}!${C.reset} ${msg}`); emit({ kind: "warn", text: msg }); },
  error(msg) { console.log(`${C.red}✖${C.reset} ${msg}`); emit({ kind: "error", text: msg }); },
  port(msg) { console.log(`${C.bold}${C.blue}[Port]${C.reset} ${msg}`); emit({ kind: "port", text: msg }); },
  agent(name, msg) {
    const c = AGENT_COLORS[name] || C.reset;
    console.log(`${c}${C.bold}[${name}]${C.reset} ${msg}`);
    emit({ kind: "agent", agent: name, text: msg });
  },
  tool(name, tool, input) {
    const c = AGENT_COLORS[name] || C.reset;
    console.log(`${c}[${name}]${C.reset} ${C.dim}→ ${tool}(${short(input || {}, 90)})${C.reset}`);
    emit({ kind: "tool", agent: name, text: `${tool}(${short(input || {}, 70)})` });
  },
  result(name, result) {
    const c = AGENT_COLORS[name] || C.reset;
    console.log(`${c}${C.bold}[${name}] ✔ ${C.reset}${short(result?.summary || result, 300)}`);
    emit({ kind: "result", agent: name, text: short(result?.summary || result, 300) });
  },
};
