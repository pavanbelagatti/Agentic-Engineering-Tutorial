// Minimal Port REST client: auth, entities, blueprints, actions, action runs.
import { cfg } from "../config.js";

let token = null;
let tokenExpiresAt = 0;

async function getToken() {
  if (token && Date.now() < tokenExpiresAt) return token;
  if (!cfg.port.clientId || !cfg.port.clientSecret) {
    throw new Error("PORT_CLIENT_ID / PORT_CLIENT_SECRET are not set in .env");
  }
  const res = await fetch(`${cfg.port.apiUrl}/v1/auth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientId: cfg.port.clientId, clientSecret: cfg.port.clientSecret }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.accessToken) throw new Error(`Port auth failed (${res.status}): ${JSON.stringify(body)}`);
  token = body.accessToken;
  tokenExpiresAt = Date.now() + ((Number(body.expiresIn) || 3600) - 120) * 1000;
  return token;
}

export async function portRequest(method, path, body, { allowStatus = [] } = {}) {
  const res = await fetch(`${cfg.port.apiUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${await getToken()}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok && !allowStatus.includes(res.status)) {
    const err = new Error(`Port ${method} ${path} → ${res.status}: ${JSON.stringify(data)}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return { status: res.status, data };
}

export const port = {
  // Create or merge-update an entity. Passing runId ties the change to an action run.
  async upsertEntity(blueprint, entity, { runId } = {}) {
    const qs = new URLSearchParams({ upsert: "true", merge: "true" });
    if (runId) qs.set("run_id", runId);
    const { data } = await portRequest("POST", `/v1/blueprints/${blueprint}/entities?${qs}`, entity);
    return data.entity;
  },
  async getEntity(blueprint, identifier) {
    const { status, data } = await portRequest("GET", `/v1/blueprints/${blueprint}/entities/${encodeURIComponent(identifier)}`, undefined, { allowStatus: [404] });
    return status === 404 ? null : data.entity;
  },
  async listEntities(blueprint) {
    const { data } = await portRequest("GET", `/v1/blueprints/${blueprint}/entities`);
    return data.entities || [];
  },
  async deleteEntity(blueprint, identifier) {
    await portRequest("DELETE", `/v1/blueprints/${blueprint}/entities/${encodeURIComponent(identifier)}`, undefined, { allowStatus: [404] });
  },

  // Execute a self-service action. If it requires approval, the run waits in Port.
  async runAction(actionId, { entity, properties }) {
    const { data } = await portRequest("POST", `/v1/actions/${actionId}/runs`, { entity, properties });
    return data.run || data;
  },
  async runLog(runId, message, { terminationStatus, statusLabel } = {}) {
    const body = { message };
    if (terminationStatus) body.terminationStatus = terminationStatus;
    if (statusLabel) body.statusLabel = statusLabel;
    await portRequest("POST", `/v1/actions/runs/${runId}/logs`, body);
  },
  // Who approved a run: the run records the approver's user id; look up their email.
  async getRunApprover(runId) {
    const { data } = await portRequest("GET", `/v1/actions/runs/${runId}`);
    const approval = (data.run || data).approval || {};
    if (approval.userEmail) return approval.userEmail;
    if (!approval.userId) return null;
    const users = await portRequest("GET", "/v1/users?fields=id&fields=email", undefined, { allowStatus: [400, 403, 404] });
    const match = (users.data.users || []).find((u) => u.id === approval.userId);
    return match?.email || null;
  },
  async updateRun(runId, patch) {
    await portRequest("PATCH", `/v1/actions/runs/${runId}`, patch);
  },

  // Setup helpers: create, or replace if it already exists.
  async applyBlueprint(bp) {
    const created = await portRequest("POST", "/v1/blueprints", bp, { allowStatus: [409, 422] });
    if (created.status < 300) return "created";
    await portRequest("PUT", `/v1/blueprints/${bp.identifier}`, bp);
    return "updated";
  },
  async applyAction(action) {
    const created = await portRequest("POST", "/v1/actions", action, { allowStatus: [409, 422] });
    if (created.status < 300) return "created";
    await portRequest("PUT", `/v1/actions/${action.identifier}`, action);
    return "updated";
  },
};
