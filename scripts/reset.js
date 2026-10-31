// npm run reset — puts everything back for another take.
// App → v2.4.0, deletes live-demo incidents and deployments, service → Healthy.
// Sample history (incidents with Source "Sample history", deployments ending in -sample) is kept,
// so the dashboard still has a month of data to compare against.
// Using the control room (npm run demo)? Its "Reset demo" button does the same without a restart.
import { resetDemo } from "../lib/reset.js";
import { log } from "../lib/log.js";

try {
  await resetDemo();
  log.ok("Restart the orchestrator (npm run agents) before the next take.");
} catch (err) {
  log.error(err.message);
  process.exit(1);
}
