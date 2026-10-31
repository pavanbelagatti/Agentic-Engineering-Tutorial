import dotenv from "dotenv";
dotenv.config({ quiet: true });

const env = process.env;

export const cfg = {
  port: {
    clientId: env.PORT_CLIENT_ID,
    clientSecret: env.PORT_CLIENT_SECRET,
    apiUrl: (env.PORT_API_URL || "https://api.port.io").replace(/\/$/, ""),
    appUrl: (env.PORT_APP_URL || "https://app.port.io").replace(/\/$/, ""),
  },
  publicWebhookUrl: (env.PUBLIC_WEBHOOK_URL || "").replace(/\/$/, ""),
  oncallEmail: env.DEMO_ONCALL_EMAIL || "you@example.com",

  agentMode: env.AGENT_MODE === "mock" || !env.OPENAI_API_KEY ? "mock" : "llm",
  model: env.OPENAI_MODEL || "gpt-5.2",

  appUrl: (env.APP_URL || "http://localhost:3001").replace(/\/$/, ""),
  appPort: Number(env.APP_PORT || 3001),
  adminToken: env.APP_ADMIN_TOKEN || "demo-admin-token",
  orchestratorPort: Number(env.ORCHESTRATOR_PORT || 4000),
  service: env.SERVICE_NAME || "payments-api",

  alertErrorRate: Number(env.ALERT_ERROR_RATE || 0.05),
  alertP99Ms: Number(env.ALERT_P99_MS || 800),
  verifyWaitSeconds: Number(env.VERIFY_WAIT_SECONDS || 30),
  verifySignature: env.VERIFY_PORT_SIGNATURE !== "false",
  loadConcurrency: Number(env.LOAD_CONCURRENCY || 20),

  // Control room (npm run demo → http://localhost:5050). Bound to this machine only.
  uiPort: Number(env.UI_PORT || 5050),
  // Who can ship from the control room, as "Display name:handle" pairs.
  people: (env.DEMO_PEOPLE || "Alex Kim:alex.kim,Pavan:pavan")
    .split(",").map((p) => p.trim()).filter(Boolean)
    .map((p) => { const [name, handle] = p.split(":"); return { name: name.trim(), handle: (handle || name).trim() }; }),
};

// Blueprint and action identifiers are prefixed so they never collide with
// an existing "service" blueprint in your Port org. Titles stay clean.
export const BP = {
  service: "demo_service",
  deployment: "demo_deployment",
  incident: "demo_incident",
};
export const ACTION_ID = "demo_rollback_service";
