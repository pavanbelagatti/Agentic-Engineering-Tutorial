// npm run deploy -- 2.4.1 --by alex.kim
// Simulates a CI/CD deploy: ships the version to the app and records it in Port.
import { deployAndRecord } from "../lib/deploy.js";
import { RELEASES } from "../app/releases.js";
import { cfg } from "../config.js";
import { log } from "../lib/log.js";

const args = process.argv.slice(2);
const version = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--by");
const byIdx = args.indexOf("--by");
const by = byIdx >= 0 ? args[byIdx + 1] : "alex.kim";

if (!RELEASES[version]) {
  log.error(`Usage: npm run deploy -- <version> [--by name]   versions: ${Object.keys(RELEASES).join(", ")}`);
  process.exit(1);
}

try {
  const d = await deployAndRecord({ version, by });
  log.ok(`Deployed ${cfg.service} v${version} (was v${d.previous}) by ${by}`);
  log.port(`Recorded deployment ${d.identifier} in the catalog`);
} catch (err) {
  log.error(err.message);
  process.exit(1);
}
