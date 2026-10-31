// Everything the demo creates in Port: 3 blueprints, 1 action, seed entities.
import { cfg, BP, ACTION_ID } from "../config.js";
import { RELEASES } from "../app/releases.js";

export const blueprints = () => [
  {
    identifier: BP.service,
    title: "Service",
    icon: "Microservice",
    schema: {
      properties: {
        owningTeam: { type: "string", title: "Owning team" },
        onCall: { type: "string", format: "email", title: "On-call" },
        slackChannel: { type: "string", title: "Slack channel" },
        tier: { type: "string", title: "Tier", enum: ["Tier 1", "Tier 2", "Tier 3"] },
        language: { type: "string", title: "Language" },
        currentVersion: { type: "string", title: "Current version" },
        health: {
          type: "string", title: "Health",
          enum: ["Healthy", "Degraded", "Down"],
          enumColors: { Healthy: "green", Degraded: "orange", Down: "red" },
        },
        dependsOn: { type: "array", title: "Depends on", items: { type: "string" } },
        runbook: { type: "string", format: "url", title: "Runbook" },
      },
      required: [],
    },
    relations: {},
  },
  {
    identifier: BP.deployment,
    title: "Deployment",
    icon: "Deployment",
    schema: {
      properties: {
        version: { type: "string", title: "Version" },
        previousVersion: { type: "string", title: "Previous version" },
        deployedBy: { type: "string", title: "Deployed by" },
        deployedAt: { type: "string", format: "date-time", title: "Deployed at" },
        commitSha: { type: "string", title: "Commit" },
        changeSummary: { type: "string", title: "Change summary" },
        kind: { type: "string", title: "Kind", enum: ["release", "rollback"], enumColors: { release: "blue", rollback: "purple" } },
        status: {
          type: "string", title: "Status",
          enum: ["Live", "Superseded", "Rolled back"],
          enumColors: { Live: "green", Superseded: "lightGray", "Rolled back": "red" },
        },
      },
      required: [],
    },
    relations: {
      service: { title: "Service", target: BP.service, required: false, many: false },
    },
  },
  {
    identifier: BP.incident,
    title: "Incident",
    icon: "Alert",
    schema: {
      properties: {
        status: {
          type: "string", title: "Status",
          enum: ["Investigating", "Awaiting approval", "Mitigating", "Resolved", "Escalated"],
          enumColors: { Investigating: "orange", "Awaiting approval": "yellow", Mitigating: "blue", Resolved: "green", Escalated: "red" },
        },
        severity: { type: "string", title: "Severity", enum: ["SEV1", "SEV2", "SEV3"], enumColors: { SEV1: "red", SEV2: "orange", SEV3: "yellow" } },
        alert: { type: "string", title: "Alert" },
        detectedAt: { type: "string", format: "date-time", title: "Detected at" },
        resolvedAt: { type: "string", format: "date-time", title: "Resolved at" },
        rootCause: { type: "string", format: "markdown", title: "Root cause" },
        confidence: { type: "number", title: "Confidence" },
        recommendedAction: { type: "string", title: "Recommended action" },
        evidence: { type: "string", format: "markdown", title: "Evidence" },
        agentTimeline: { type: "string", format: "markdown", title: "Agent timeline" },
      },
      required: [],
    },
    relations: {
      service: { title: "Service", target: BP.service, required: false, many: false },
      suspectDeployment: { title: "Suspect deployment", target: BP.deployment, required: false, many: false },
    },
  },
];

export const rollbackAction = () => ({
  identifier: ACTION_ID,
  title: "Rollback service",
  icon: "Deployment",
  description: "Roll a service back to a previous version. Requested by the incident agents, approved by a human.",
  trigger: {
    type: "self-service",
    operation: "DAY-2",
    blueprintIdentifier: BP.service,
    userInputs: {
      properties: {
        target_version: { type: "string", title: "Target version" },
        incident_id: { type: "string", title: "Incident" },
        reason: { type: "string", format: "markdown", title: "Reason" },
      },
      required: ["target_version"],
      order: ["target_version", "incident_id", "reason"],
    },
  },
  invocationMethod: {
    type: "WEBHOOK",
    url: `${cfg.publicWebhookUrl || "https://REPLACE-WITH-YOUR-TUNNEL"}/port/webhook`,
    agent: false,
    synchronized: false,
    method: "POST",
    headers: { RUN_ID: "{{ .run.id }}" },
    body: {
      runId: "{{ .run.id }}",
      service: "{{ .entity.identifier }}",
      targetVersion: "{{ .inputs.target_version }}",
      incidentId: "{{ .inputs.incident_id }}",
      reason: "{{ .inputs.reason }}",
    },
  },
  requiredApproval: { type: "ANY" },
  approvalNotification: { type: "email" },
});

const daysAgo = (d) => new Date(Date.now() - d * 86_400_000).toISOString();

export const seedServices = () => [
  {
    identifier: cfg.service,
    title: cfg.service,
    properties: {
      owningTeam: "Payments", onCall: cfg.oncallEmail, slackChannel: "#payments-oncall",
      tier: "Tier 1", language: "Node.js", currentVersion: "2.4.0", health: "Healthy",
      dependsOn: ["postgres-payments", "fraud-check", "ledger-service"],
      runbook: "https://example.com/runbooks/payments-api",
    },
  },
  {
    identifier: "fraud-check", title: "fraud-check",
    properties: { owningTeam: "Risk", onCall: "risk-oncall@example.com", slackChannel: "#risk-oncall", tier: "Tier 1", language: "Go", currentVersion: "1.12.3", health: "Healthy", dependsOn: ["redis-risk"] },
  },
  {
    identifier: "ledger-service", title: "ledger-service",
    properties: { owningTeam: "Finance Platform", onCall: "ledger-oncall@example.com", slackChannel: "#ledger", tier: "Tier 1", language: "Java", currentVersion: "5.0.8", health: "Healthy", dependsOn: ["postgres-ledger"] },
  },
  {
    identifier: "checkout-web", title: "checkout-web",
    properties: { owningTeam: "Checkout", onCall: "checkout-oncall@example.com", slackChannel: "#checkout", tier: "Tier 2", language: "TypeScript", currentVersion: "3.7.0", health: "Healthy", dependsOn: [cfg.service] },
  },
];

export const seedDeployments = () => [
  {
    identifier: `${cfg.service}-2.3.2-baseline`,
    title: `${cfg.service} v2.3.2`,
    properties: {
      version: "2.3.2", previousVersion: "2.3.1", deployedBy: "sam.okafor", deployedAt: daysAgo(9),
      commitSha: RELEASES["2.3.2"].commit, changeSummary: RELEASES["2.3.2"].summary, kind: "release", status: "Superseded",
    },
    relations: { service: cfg.service },
  },
  {
    identifier: `${cfg.service}-2.4.0-baseline`,
    title: `${cfg.service} v2.4.0`,
    properties: {
      version: "2.4.0", previousVersion: "2.3.2", deployedBy: "maya.chen", deployedAt: daysAgo(3),
      commitSha: RELEASES["2.4.0"].commit, changeSummary: RELEASES["2.4.0"].summary, kind: "release", status: "Live",
    },
    relations: { service: cfg.service },
  },
];
