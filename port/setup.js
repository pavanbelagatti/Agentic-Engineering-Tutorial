// npm run port:setup         → blueprints + seed entities + rollback action
// npm run port:action        → only (re)create the action (after your tunnel URL changes)
// npm run port:print         → print the JSON so you can paste it into Port's UI instead
import { cfg, BP } from "../config.js";
import { port } from "./client.js";
import { log } from "../lib/log.js";
import { blueprints, rollbackAction, seedServices, seedDeployments } from "./definitions.js";

const args = new Set(process.argv.slice(2));

// Retry without the icon if Port rejects an icon name, so setup never blocks on cosmetics.
async function applyWithIconFallback(fn, def) {
  try {
    return await fn(def);
  } catch (err) {
    if (err.status === 422 && def.icon && /icon/i.test(JSON.stringify(err.data))) {
      const { icon, ...rest } = def;
      log.warn(`Icon "${icon}" not accepted for ${def.identifier}, retrying without it`);
      return await fn(rest);
    }
    throw err;
  }
}

async function applyAction() {
  if (!cfg.publicWebhookUrl) {
    log.warn("PUBLIC_WEBHOOK_URL is empty, so the action would point nowhere. Start your tunnel, set it in .env, then run: npm run port:action");
    return;
  }
  const result = await applyWithIconFallback((a) => port.applyAction(a), rollbackAction());
  log.ok(`Action "Rollback service" ${result} → ${cfg.publicWebhookUrl}/port/webhook`);
}

async function main() {
  if (args.has("--print")) {
    console.log(JSON.stringify({ blueprints: blueprints(), action: rollbackAction() }, null, 2));
    return;
  }
  if (args.has("--action-only")) return applyAction();

  log.banner("Setting up Port for the agentic incident demo");
  for (const bp of blueprints()) {
    const result = await applyWithIconFallback((b) => port.applyBlueprint(b), bp);
    log.ok(`Blueprint ${bp.title} (${bp.identifier}) ${result}`);
  }
  for (const s of seedServices()) await port.upsertEntity(BP.service, s);
  log.ok(`Seeded ${seedServices().length} services`);
  for (const d of seedDeployments()) await port.upsertEntity(BP.deployment, d);
  log.ok(`Seeded ${seedDeployments().length} deployments for ${cfg.service}`);
  await applyAction();

  log.banner("Done", "Next: in Port, open the action's settings and choose who can approve it (see README step 4).");
}

main().catch((err) => { log.error(err.message); process.exit(1); });
