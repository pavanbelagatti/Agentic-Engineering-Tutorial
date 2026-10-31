// Correlation Agent: no tools. Reasons over the three specialists' findings.
import { runAgent } from "./runAgent.js";

export function correlationAgent({ service, alert, metrics, logs, deployment }) {
  return runAgent({
    name: "Correlation Agent",
    system: `You are the Correlation Agent on an incident-response team. You receive findings from
three specialists (metrics, logs, deployments). Build a timeline, then name the most likely root cause.
Rules: a root cause must be supported by at least two independent signals. Call out signals that are
noise. Recommend "rollback" only if a deployment precedes the anomaly and the evidence links them;
otherwise recommend "escalate". Be calibrated about confidence.`,
    task: `Service: ${service}
Alert: ${alert.summary} (at ${alert.at})

Metrics Agent findings:
${JSON.stringify(metrics, null, 2)}

Logs Agent findings:
${JSON.stringify(logs, null, 2)}

Deployment Agent findings:
${JSON.stringify(deployment, null, 2)}

Return JSON: {"summary": string (2 sentences max), "rootCause": string, "confidence": number between 0 and 1, "timeline": [string], "evidence": [string], "ruledOut": [string], "suspectDeploymentId": string or null, "recommendedAction": {"type": "rollback" | "escalate", "targetVersion": string or null, "reason": string}}`,
    tools: [],
    mock: async () => {
      const change = deployment.recentChange;
      const anomalyAt = Date.parse(metrics.anomalyStartedAt || alert.at);
      const deployedAt = change ? Date.parse(change.deployedAt) : NaN;
      const linked = change && deployedAt <= anomalyAt + 30_000 && anomalyAt - deployedAt < 30 * 60_000;
      if (!linked) {
        return {
          summary: "No recent change explains the anomaly. Escalating to the owning team.",
          rootCause: "Unknown", confidence: 0.3, timeline: [], evidence: [metrics.summary, logs.summary], ruledOut: [],
          suspectDeploymentId: null,
          recommendedAction: { type: "escalate", targetVersion: null, reason: "No deployment correlates with the anomaly." },
        };
      }
      return {
        summary: `v${change.version} shrank the DB connection pool, so ${service} exhausts connections under normal load. Rolling back to v${change.previousVersion} should restore service.`,
        rootCause: `Deployment v${change.version} ("${change.changeSummary}") reduced the database connection pool to ${logs.clues?.[0]?.match(/max_connections=(\d+)/)?.[1] || "a very small size"}. Under normal traffic, requests queue for a connection and time out (DB_POOL_TIMEOUT).`,
        confidence: 0.92,
        timeline: [
          `${change.deployedAt}: v${change.version} deployed by ${change.deployedBy}`,
          `${logs.dominantError?.firstSeen}: first ${logs.dominantError?.code} error`,
          `${metrics.anomalyStartedAt}: error rate and p99 step up`,
          `${alert.at}: alert fired`,
        ],
        evidence: [
          `Deployment v${change.version} landed right before the anomaly (Port catalog)`,
          `Change summary mentions lowering connection pool defaults`,
          `${logs.dominantError?.count} DB_POOL_TIMEOUT errors; pool initialised with a tiny max (logs)`,
          `Abrupt step change in error rate and latency with steady traffic (metrics)`,
        ],
        ruledOut: ["FRAUD_CHECK_TIMEOUT errors: low constant background rate before and after the deploy", "Traffic surge: incoming load did not increase"],
        suspectDeploymentId: change.deploymentId,
        recommendedAction: { type: "rollback", targetVersion: change.previousVersion, reason: `Restore v${change.previousVersion}, the last version with a healthy pool configuration.` },
      };
    },
  });
}
