// Metrics Agent: only looks at traffic, error rate and latency.
import { runAgent } from "./runAgent.js";
import { appClient } from "../lib/appClient.js";
import { cfg } from "../config.js";

const isBad = (b) => b.errorRate > cfg.alertErrorRate || b.p99 > cfg.alertP99Ms;
const median = (xs) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

export function metricsAgent({ service, alert }) {
  return runAgent({
    name: "Metrics Agent",
    system: `You are the Metrics Agent on an incident-response team for the service "${service}".
You can only see metrics: request rate, error rate and latency percentiles.
Find when the anomaly started, how bad it is compared with the baseline, and which signals changed.
Do not speculate about causes you cannot see in metrics; other agents cover logs and deployments.`,
    task: `Alert: ${alert.summary}
Investigate the metrics for ${service}.
Return JSON: {"summary": string (2 sentences max), "anomalyStartedAt": ISO timestamp or null, "severity": "low" | "medium" | "high", "baseline": {"errorRate": number, "p99": number, "rps": number}, "current": {"errorRate": number, "p99": number, "rps": number}, "signals": [string]}`,
    tools: [
      {
        name: "get_service_metrics",
        description: "Time-bucketed request rate, error rate (0-1) and p50/p95/p99 latency (ms) for the service, plus a summary of the last 30 seconds.",
        input_schema: {
          type: "object",
          properties: {
            window_seconds: { type: "integer", description: "How far back to look, 60-900. Default 600." },
            bucket_seconds: { type: "integer", description: "Bucket size in seconds. Default 15." },
          },
        },
        run: ({ window_seconds = 600, bucket_seconds = 15 }) => appClient.metrics(window_seconds, bucket_seconds),
      },
    ],
    mock: async (call) => {
      const m = await call("get_service_metrics", { window_seconds: 600 });
      const b = m.buckets.filter((x) => x.requests > 0);
      let i = b.length - 1;
      while (i >= 0 && isBad(b[i])) i--;
      const badRun = b.slice(i + 1);
      const base = b.slice(0, Math.max(1, i)); // exclude the bucket right before the step change
      const baseline = { errorRate: median(base.map((x) => x.errorRate)), p99: median(base.map((x) => x.p99)), rps: median(base.map((x) => x.rps)) };
      const current = { errorRate: m.current30s.errorRate, p99: m.current30s.p99, rps: m.current30s.rps };
      const start = badRun[0]?.start || null;
      const pctOf = (x) => `${(x * 100).toFixed(1)}%`;
      return {
        summary: `Error rate jumped from ${pctOf(baseline.errorRate)} to ${pctOf(current.errorRate)} and p99 latency from ${baseline.p99}ms to ${current.p99}ms${start ? `, starting around ${start}` : ""}.${current.rps < baseline.rps * 0.8 ? ` Throughput fell from ${baseline.rps} to ${current.rps} req/s as requests started queueing.` : ""}`,
        anomalyStartedAt: start,
        severity: current.errorRate > 0.25 ? "high" : "medium",
        baseline, current,
        signals: ["error rate spike", "p99 latency increase", "abrupt step change (not gradual growth)"],
      };
    },
  });
}
