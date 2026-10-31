// What a CD pipeline would do: ship the version, then record it in Port.
import { cfg, BP } from "../config.js";
import { RELEASES } from "../app/releases.js";
import { appClient } from "./appClient.js";
import { port } from "../port/client.js";

export async function deployAndRecord({ version, by, kind = "release", runId, rolledBackDeploymentId }) {
  const service = cfg.service;
  const { previous } = await appClient.deploy(version);
  const now = new Date().toISOString();
  const identifier = `${service}-${version}-${Date.now()}`;

  // Mark whatever was live as superseded (or rolled back).
  const deployments = await port.listEntities(BP.deployment);
  for (const d of deployments) {
    if (d.relations?.service !== service || d.properties?.status !== "Live") continue;
    const status = d.identifier === rolledBackDeploymentId ? "Rolled back" : "Superseded";
    await port.upsertEntity(BP.deployment, { identifier: d.identifier, properties: { status } }, { runId });
  }
  if (rolledBackDeploymentId) {
    await port.upsertEntity(BP.deployment, { identifier: rolledBackDeploymentId, properties: { status: "Rolled back" } }, { runId });
  }

  await port.upsertEntity(BP.deployment, {
    identifier,
    title: `${service} v${version}${kind === "rollback" ? " (rollback)" : ""}`,
    properties: {
      version, previousVersion: previous, deployedBy: by, deployedAt: now,
      commitSha: RELEASES[version].commit,
      changeSummary: kind === "rollback" ? `Rollback to v${version}` : RELEASES[version].summary,
      kind, status: "Live",
    },
    relations: { service },
  }, { runId });

  await port.upsertEntity(BP.service, { identifier: service, properties: { currentVersion: version } }, { runId });
  return { identifier, previous, deployedAt: now };
}
