// Deployment Agent: asks Port what the service is, who owns it, and what changed.
import { runAgent } from "./runAgent.js";
import { port } from "../port/client.js";
import { BP } from "../config.js";

async function getServiceContext({ service }) {
  const e = await port.getEntity(BP.service, service);
  return e ? { identifier: e.identifier, ...e.properties } : { error: `No service ${service} in the catalog` };
}

async function listRecentDeployments({ service, limit = 5 }) {
  const all = await port.listEntities(BP.deployment);
  return all
    .filter((d) => d.relations?.service === service)
    .sort((a, b) => Date.parse(b.properties.deployedAt) - Date.parse(a.properties.deployedAt))
    .slice(0, limit)
    .map((d) => ({ deploymentId: d.identifier, ...d.properties }));
}

export function deploymentAgent({ service, alert }) {
  return runAgent({
    name: "Deployment Agent",
    system: `You are the Deployment Agent on an incident-response team.
Your source of truth is the Port software catalog. Use it to learn what the service is,
who owns it, what it depends on, and what changed recently (deployments, versions, authors, change summaries).`,
    task: `Alert: ${alert.summary} (alert time ${alert.at})
Investigate recent changes to ${service}.
Return JSON: {"summary": string (2 sentences max), "owner": {"team": string, "onCall": string, "slackChannel": string}, "dependencies": [string], "recentChange": {"deploymentId": string, "version": string, "previousVersion": string, "deployedAt": ISO timestamp, "deployedBy": string, "changeSummary": string, "commitSha": string} or null, "signals": [string]}`,
    tools: [
      {
        name: "get_service_context",
        description: "Get a service from the Port catalog: owning team, on-call, Slack channel, tier, current version, health, dependencies, runbook.",
        input_schema: { type: "object", properties: { service: { type: "string" } }, required: ["service"] },
        run: getServiceContext,
      },
      {
        name: "list_recent_deployments",
        description: "List the most recent deployments of a service from the Port catalog, newest first.",
        input_schema: { type: "object", properties: { service: { type: "string" }, limit: { type: "integer" } }, required: ["service"] },
        run: listRecentDeployments,
      },
    ],
    mock: async (call) => {
      const svc = await call("get_service_context", { service });
      const deps = await call("list_recent_deployments", { service, limit: 5 });
      const latest = deps[0];
      const minutesAgo = latest ? Math.round((Date.now() - Date.parse(latest.deployedAt)) / 60000) : null;
      return {
        summary: latest
          ? `v${latest.version} was deployed ${minutesAgo < 1 ? "under a minute" : `${minutesAgo} min`} ago by ${latest.deployedBy} ("${latest.changeSummary}"), replacing v${latest.previousVersion}. ${svc.owningTeam} owns this Tier 1 service; on-call is ${svc.onCall}.`
          : `No recent deployments of ${service}.`,
        owner: { team: svc.owningTeam, onCall: svc.onCall, slackChannel: svc.slackChannel },
        dependencies: svc.dependsOn || [],
        recentChange: latest ? {
          deploymentId: latest.deploymentId, version: latest.version, previousVersion: latest.previousVersion,
          deployedAt: latest.deployedAt, deployedBy: latest.deployedBy, changeSummary: latest.changeSummary, commitSha: latest.commitSha,
        } : null,
        signals: latest && minutesAgo < 30 ? ["deployment shortly before the alert", "change touches DB client configuration"] : [],
      };
    },
  });
}
