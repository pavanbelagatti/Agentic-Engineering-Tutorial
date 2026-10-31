// Puts the demo back to the start: app on v2.4.0, live-demo incidents and deployments removed,
// service Healthy. Sample history is kept so the dashboard still has data to compare against.
import { cfg, BP } from "../config.js";
import { GOOD_VERSION } from "../app/releases.js";
import { appClient } from "./appClient.js";
import { port } from "../port/client.js";
import { log } from "./log.js";

export async function resetDemo() {
  await appClient.deploy(GOOD_VERSION).then(() => log.ok(`App back on v${GOOD_VERSION}`)).catch((e) => log.warn(`App not reachable (${e.message}), skipping`));

  const incidents = (await port.listEntities(BP.incident)).filter((i) => i.properties?.source !== "Sample history");
  for (const i of incidents) await port.deleteEntity(BP.incident, i.identifier);
  log.ok(`Deleted ${incidents.length} live-demo incident(s), kept sample history`);

  const deployments = (await port.listEntities(BP.deployment)).filter((d) => !d.identifier.endsWith("-baseline") && !d.identifier.endsWith("-sample"));
  for (const d of deployments) await port.deleteEntity(BP.deployment, d.identifier);
  await port.upsertEntity(BP.deployment, { identifier: `${cfg.service}-2.4.0-baseline`, properties: { status: "Live" } });
  log.ok(`Deleted ${deployments.length} demo deployment(s), baseline v${GOOD_VERSION} is Live again`);

  await port.upsertEntity(BP.service, { identifier: cfg.service, properties: { currentVersion: GOOD_VERSION, health: "Healthy" } });
  log.ok(`${cfg.service} is Healthy on v${GOOD_VERSION}`);
}
