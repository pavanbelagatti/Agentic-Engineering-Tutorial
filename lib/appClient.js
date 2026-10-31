// Talks to the demo app. In a real setup these calls would go to your
// observability vendor (metrics, logs) and your CD system (deploy).
import { cfg } from "../config.js";

async function call(path, init) {
  const res = await fetch(`${cfg.appUrl}${path}`, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`App ${path} → ${res.status}: ${JSON.stringify(body)}`);
  return body;
}

export const appClient = {
  health: () => call("/health"),
  metrics: (windowSeconds = 600, bucketSeconds = 15, since = "") =>
    call(`/internal/metrics?window_seconds=${windowSeconds}&bucket_seconds=${bucketSeconds}${since ? `&since=${encodeURIComponent(since)}` : ""}`),
  logs: ({ level = "all", since_seconds = 600, limit = 40, query = "" } = {}) =>
    call(`/internal/logs?level=${level}&since_seconds=${since_seconds}&limit=${limit}&query=${encodeURIComponent(query)}`),
  deploy: (version) =>
    call("/admin/deploy", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-admin-token": cfg.adminToken },
      body: JSON.stringify({ version }),
    }),
};
