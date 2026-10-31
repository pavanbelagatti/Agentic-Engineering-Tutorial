// Verify Agent: checks the metrics after the rollback.
import { runAgent } from "./runAgent.js";
import { appClient } from "../lib/appClient.js";
import { cfg } from "../config.js";

export function verifyAgent({ service, rollbackAt, baseline }) {
  return runAgent({
    name: "Verify Agent",
    system: `You are the Verify Agent. A rollback of "${service}" was just executed. Decide from metrics alone
whether the service has recovered: error rate below ${cfg.alertErrorRate * 100}% and p99 below ${cfg.alertP99Ms}ms
in the period after the rollback, with traffic flowing. Only consider buckets after the rollback time.`,
    task: `Rollback executed at ${rollbackAt}. Pre-incident baseline: ${JSON.stringify(baseline || {})}.
Return JSON: {"summary": string (1-2 sentences), "recovered": boolean, "after": {"errorRate": number, "p99": number, "rps": number}}`,
    tools: [
      {
        name: "get_service_metrics",
        description: "Time-bucketed request rate, error rate (0-1) and latency percentiles (ms), plus a summary of the last 30 seconds. Pass `since` (ISO timestamp) to also get `sinceSummary`: totals for all requests after that moment.",
        input_schema: { type: "object", properties: { window_seconds: { type: "integer" }, bucket_seconds: { type: "integer" }, since: { type: "string", description: "ISO timestamp, e.g. the rollback time" } } },
        run: ({ window_seconds = 120, bucket_seconds = 10, since = "" }) => appClient.metrics(window_seconds, bucket_seconds, since),
      },
    ],
    mock: async (call) => {
      // Skip the first few seconds so in-flight requests from the bad version don't count.
      const since = new Date(Date.parse(rollbackAt) + 3_000).toISOString();
      const m = await call("get_service_metrics", { window_seconds: 120, bucket_seconds: 10, since });
      const s = m.sinceSummary;
      const recovered = s.requests > 0 && s.errorRate < cfg.alertErrorRate && s.p99 < cfg.alertP99Ms;
      const pctOf = (x) => `${(x * 100).toFixed(1)}%`;
      return {
        summary: recovered
          ? `Recovered: since the rollback, error rate is ${pctOf(s.errorRate)} and p99 ${s.p99}ms at ${s.rps} req/s, back in line with the baseline.`
          : `Error rate is still ${pctOf(s.errorRate)} with p99 ${s.p99}ms since the rollback.`,
        recovered,
        after: { errorRate: s.errorRate, p99: s.p99, rps: s.rps },
      };
    },
  });
}
