// Logs Agent: only searches application logs.
import { runAgent } from "./runAgent.js";
import { appClient } from "../lib/appClient.js";

export function logsAgent({ service, alert }) {
  return runAgent({
    name: "Logs Agent",
    system: `You are the Logs Agent on an incident-response team for the service "${service}".
You can only search application logs. Identify the dominant error, when it first appeared,
and any log lines that hint at a cause (configuration changes, startup messages, resource limits).
Search iteratively: start broad, then search for specific terms you discover.`,
    task: `Alert: ${alert.summary}
Investigate the logs for ${service}.
Return JSON: {"summary": string (2 sentences max), "dominantError": {"code": string, "count": number, "firstSeen": ISO timestamp, "example": string}, "clues": [string], "signals": [string]}`,
    tools: [
      {
        name: "search_logs",
        description: "Search recent application logs. Returns matching entries (oldest first, capped by limit), total count, counts by error code, and the first matching timestamp.",
        input_schema: {
          type: "object",
          properties: {
            level: { type: "string", enum: ["all", "error", "warn", "info"], description: "Log level filter. Default all." },
            query: { type: "string", description: "Case-insensitive substring to match in the message." },
            since_seconds: { type: "integer", description: "How far back to search. Default 600." },
            limit: { type: "integer", description: "Max entries returned, up to 200. Default 40." },
          },
        },
        run: (input) => appClient.logs(input),
      },
    ],
    mock: async (call) => {
      const errors = await call("search_logs", { level: "error", limit: 10 });
      const [code, count] = Object.entries(errors.countsByCode).sort((a, b) => b[1] - a[1])[0] || ["none", 0];
      const term = code === "DB_POOL_TIMEOUT" ? "DBConnectionTimeout" : code;
      const first = await call("search_logs", { level: "error", query: term, limit: 1 });
      const pool = await call("search_logs", { level: "info", query: "pool initialised", limit: 5 });
      const lastInit = pool.entries.at(-1);
      const clues = lastInit ? [`${lastInit.ts}: "${lastInit.message}" (logged by v${lastInit.version})`] : [];
      return {
        summary: `${count} ${code} errors: requests time out waiting for a database connection. The most recent pool initialisation shows ${lastInit ? lastInit.message.split(": ")[1] : "an unknown size"}, which is far too small for current traffic.`,
        dominantError: { code, count, firstSeen: first.firstSeen, example: first.entries[0]?.message || "" },
        clues,
        signals: ["DB connection pool exhaustion", "pool size changed at last startup", "background FRAUD_CHECK_TIMEOUT noise is unrelated (low, constant rate)"],
      };
    },
  });
}
