/**
 * A stand-in for the provisioner, serving the routes the scripts call with
 * the provisioner's real shapes (crates/provisioner/src/api/*.rs).
 *
 * It enforces what the real one enforces about the caller -- the bearer
 * token, an X-Actor-Did, owner scoping, and staff seeing everything -- so a
 * script that forgets to scope a call is caught here, not in production.
 *
 * Mutating routes behave as the real ones do behind its idempotency layer
 * (crates/provisioner/src/idempotency.rs): no Idempotency-Key is a 400, a
 * successful reply is stored per actor and key and replayed verbatim to a
 * retry, the same key on a different request is a 422, and a failure is not
 * stored, so a retry runs again.
 *
 * Control routes, all under /__:
 *   POST /__state    seed { tenants?, operations?, plans?, staff?, instanceLimit? }
 *   POST /__script   queue one canned reply { method, path, status, body }; the
 *                    next request matching method and path gets it, once
 *   POST /__progress queue the states the NEXT operation a mutating route
 *                    creates moves through, one per GET /v1/operations/:id:
 *                    [{ status, step?, error_code?, error_message? }, ...]. It
 *                    holds at the last. An entry { http: 503, error? } answers
 *                    that read with that error status and code instead,
 *                    leaving the operation as it was. Without one, an operation succeeds
 *                    at its first read.
 *   GET  /__requests every request received since the last reset
 *   POST /__reset    clear state, scripts, progressions and requests
 *
 * Runs inside the stack (compose.yml), and is driven from the tests through
 * its published port.
 */

type Json = any;

type Recorded = {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: Json;
};

type Scripted = { method: string; path: string; status: number; body: Json };

type Progress =
  | { status: string; step?: string; error_code?: string; error_message?: string; http?: undefined }
  | { http: number; error?: string };

const TOKEN = process.env.PROVISIONER_TOKEN ?? "integration-provisioner-token";

const DEFAULT_PLANS = [
  { id: "small", name: "Small", memory_mb: 512, cpu_millis: 500, disk_gb: 5 },
  { id: "medium", name: "Medium", memory_mb: 1024, cpu_millis: 1000, disk_gb: 10 },
];

let state = fresh();
let scripts: Scripted[] = [];
let requests: Recorded[] = [];
/** Progressions waiting for the next operation a mutating route creates. */
let queuedProgress: Progress[][] = [];
/** Operation id -> the states its reads still have to move through. */
let progress = new Map<string, Progress[]>();
/** `actor\nkey` -> the request it was first used for, and the stored reply. */
let idempotency = new Map<string, { request: string; status: number; body: Json }>();

function fresh() {
  return {
    tenants: [] as Json[],
    operations: [] as Json[],
    plans: DEFAULT_PLANS as Json[],
    staff: [] as string[],
    instanceLimit: 3,
  };
}

function reply(status: number, body: Json): Response {
  return Response.json(body, { status });
}

function error(status: number, code: string, message: string): Response {
  return reply(status, { error: code, message });
}

/** The tenant as the real list and get serialise it: every column. */
function tenantRow(t: Json): Json {
  const { current_operation: _, ...row } = t;
  return row;
}

/** The newest pending or running operation for a tenant, full shape. */
function activeOperation(tenantId: string): Json {
  const live = state.operations.filter(
    (o) => o.tenant_id === tenantId && (o.status === "pending" || o.status === "running"),
  );
  return live.at(-1) ?? null;
}

/** The list's compact `current_operation`: id, kind, status, step?. */
function compactOperation(op: Json): Json {
  if (!op) return null;
  const out: Json = { id: op.id, kind: op.kind, status: op.status };
  const last = Array.isArray(op.steps) ? op.steps.at(-1) : undefined;
  if (last?.name) out.step = last.name;
  return out;
}

/** A new pending operation, as ops::enqueue writes it. */
function enqueue(tenantId: string, kind: string, params: Json, actor: string): Json {
  const op = {
    id: crypto.randomUUID(),
    tenant_id: tenantId,
    kind,
    status: "pending",
    params,
    steps: [],
    error_code: null,
    error_message: null,
    requested_by: actor,
    created_at: new Date().toISOString(),
    started_at: null,
    finished_at: null,
  };
  state.operations.push(op);
  progress.set(op.id, queuedProgress.shift() ?? [{ status: "succeeded" }]);
  return op;
}

/**
 * Move an operation to its next scripted state, in place. Returns the HTTP
 * status to fail this read with, when that is what the script says.
 */
function advance(op: Json): { http: number; error?: string } | undefined {
  const states = progress.get(op.id);
  if (!states || states.length === 0) return;
  const next = states.length > 1 ? states.shift()! : states[0];
  if (next.http !== undefined) return next;
  op.status = next.status;
  if (next.step && op.steps.at(-1)?.name !== next.step) {
    op.steps.push({ name: next.step, status: "ok", at: new Date().toISOString() });
  }
  op.error_code = next.error_code ?? null;
  op.error_message = next.error_message ?? null;
  if (op.status !== "pending") op.started_at ??= new Date().toISOString();
  if (op.status !== "pending" && op.status !== "running") op.finished_at = new Date().toISOString();
}

/** POST /v1/tenants, tenants::create's checks in its order. */
function createTenant(body: Json, actor: string, staff: boolean): Response {
  if (!body || typeof body !== "object") return error(400, "InvalidRequest", "body must be JSON");
  if (!(staff || body.owner_did === actor)) {
    return error(403, "Forbidden", "you can only create instances for yourself");
  }
  if (!state.plans.some((p) => p.id === body.plan)) {
    return error(400, "UnknownPlan", "no such plan");
  }
  const owned = state.tenants.filter((t) => t.owner_did === body.owner_did && !t.deleted_at);
  if (owned.length >= state.instanceLimit) {
    return error(409, "InstanceLimit", "this account has the maximum number of instances");
  }
  if (state.tenants.some((t) => t.slug === body.slug)) {
    return error(409, "SlugTaken", "that slug is taken");
  }
  const tenant = {
    id: crypto.randomUUID(),
    slug: body.slug,
    owner_did: body.owner_did,
    plan_id: body.plan,
    host_id: "99999999-9999-4999-8999-999999999999",
    happyview_version: body.version ?? "3.0.0-alpha.4",
    public_url: `https://${body.slug}.happyview.app`,
    image: "ghcr.io/gamesgamesgamesgamesgames/happyview",
    routed: false,
    desired_state: "running",
    observed_state: "pending",
    spec_hash: null,
    created_at: new Date().toISOString(),
    deleted_at: null,
    purge_after: null,
    purged_at: null,
    owner_confirmed_at: null,
  };
  state.tenants.push(tenant);
  const operation = enqueue(tenant.id, "create", {}, actor);
  return reply(201, { tenant, operation });
}

/** PATCH /v1/tenants/:id: plan and version, upgrade when the version moves. */
function updateTenant(tenant: Json, body: Json, actor: string): Response {
  const plan = body?.plan;
  const version = body?.version;
  if (plan == null && version == null) return error(400, "EmptyUpdate", "give a plan or a version");
  const params: Json = {};
  if (plan != null && plan !== tenant.plan_id) {
    if (!state.plans.some((p) => p.id === plan)) return error(400, "UnknownPlan", "no such plan");
    params.plan = { from: tenant.plan_id, to: plan };
  }
  if (version != null && version !== tenant.happyview_version) {
    params.version = { from: tenant.happyview_version, to: version };
  }
  if (Object.keys(params).length === 0) {
    return error(400, "NoChange", "the instance already has that plan and version");
  }
  const operation = enqueue(tenant.id, params.version ? "upgrade" : "update", params, actor);
  if (params.plan) tenant.plan_id = plan;
  if (params.version) tenant.happyview_version = version;
  return reply(202, { operation });
}

async function route(req: Request, url: URL, actor: string, body: Json): Promise<Response> {
  const staff = state.staff.includes(actor);
  const can = (owner: string) => staff || owner === actor;
  const parts = url.pathname.split("/").filter(Boolean); // ["v1", ...]
  const [, resource, id] = parts;

  if (req.method === "GET" && resource === "plans" && parts.length === 2) {
    return reply(200, { plans: state.plans });
  }

  if (req.method === "GET" && resource === "account" && parts.length === 2) {
    const count = state.tenants.filter((t) => t.owner_did === actor && !t.deleted_at).length;
    return reply(200, { instance_count: count, instance_limit: state.instanceLimit });
  }

  if (req.method === "GET" && resource === "slugs" && parts.length === 3) {
    const slug = decodeURIComponent(id);
    if (!/^[a-z][a-z0-9-]{1,30}[a-z0-9]$/.test(slug) || slug.includes("--")) {
      return reply(200, { available: false, reason: "invalid" });
    }
    if (state.tenants.some((t) => t.slug === slug)) {
      return reply(200, { available: false, reason: "taken" });
    }
    return reply(200, { available: true });
  }

  if (req.method === "GET" && resource === "tenants" && parts.length === 2) {
    const asked = url.searchParams.get("owner_did");
    let owner: string | null;
    if (staff) owner = asked;
    else if (asked === null || asked === actor) owner = actor;
    else return error(403, "Forbidden", "you can only list your own instances");
    const tenants = state.tenants
      .filter((t) => !t.deleted_at && (owner === null || t.owner_did === owner))
      .map((t) => ({
        ...tenantRow(t),
        current_operation:
          "current_operation" in t ? t.current_operation : compactOperation(activeOperation(t.id)),
      }));
    return reply(200, { tenants });
  }

  if (req.method === "GET" && resource === "tenants" && parts.length === 3) {
    const tenant = state.tenants.find((t) => t.id === id);
    if (!tenant || !can(tenant.owner_did)) return error(404, "NotFound", "instance not found");
    const current =
      "current_operation" in tenant ? tenant.current_operation : activeOperation(tenant.id);
    return reply(200, { tenant: tenantRow(tenant), current_operation: current });
  }

  if (req.method === "GET" && resource === "hosts" && parts.length === 2) {
    if (!staff) return error(403, "Forbidden", "staff only");
    return reply(200, { hosts: [] });
  }

  if (req.method === "GET" && resource === "operations" && parts.length === 3) {
    const op = state.operations.find((o) => o.id === id);
    const tenant = op && state.tenants.find((t) => t.id === op.tenant_id);
    if (!op || !tenant || !can(tenant.owner_did)) {
      return error(404, "NotFound", "operation not found");
    }
    const failed = advance(op);
    if (failed) {
      return error(failed.http, failed.error ?? "Internal", "SENTINEL-poll the fake was told to fail this read");
    }
    return reply(200, { operation: op });
  }

  if (req.method === "POST" && resource === "tenants" && parts.length === 2) {
    return createTenant(body, actor, staff);
  }

  if (resource === "tenants" && id) {
    const verb = parts[3];
    const known =
      (req.method === "PATCH" && parts.length === 3) ||
      (req.method === "DELETE" && parts.length === 3) ||
      (req.method === "POST" && parts.length === 4 && (verb === "start" || verb === "stop"));
    if (known) {
      const tenant = state.tenants.find((t) => t.id === id);
      if (!tenant || !can(tenant.owner_did)) return error(404, "NotFound", "instance not found");
      if (tenant.desired_state === "deleted") {
        return error(409, "TenantDeleted", "this instance has been deleted");
      }
      if (activeOperation(tenant.id)) {
        return error(409, "OperationInProgress", "an operation is already in progress for this instance");
      }
      if (req.method === "PATCH") return updateTenant(tenant, body, actor);
      if (req.method === "DELETE") {
        tenant.desired_state = "deleted";
        tenant.deleted_at = new Date().toISOString();
        return reply(202, { operation: enqueue(tenant.id, "destroy", {}, actor) });
      }
      tenant.desired_state = verb === "start" ? "running" : "stopped";
      return reply(202, { operation: enqueue(tenant.id, verb, {}, actor) });
    }
  }

  return error(404, "NotFound", `the fake provisioner has no route for ${req.method} ${url.pathname}`);
}

async function control(req: Request, url: URL): Promise<Response> {
  switch (`${req.method} ${url.pathname}`) {
    case "GET /__health":
      return reply(200, { ok: true });
    case "GET /__requests":
      return reply(200, requests);
    case "POST /__reset":
      state = fresh();
      scripts = [];
      requests = [];
      queuedProgress = [];
      progress = new Map();
      idempotency = new Map();
      return reply(200, {});
    case "POST /__progress":
      queuedProgress.push((await req.json()) as Progress[]);
      return reply(200, {});
    case "POST /__state": {
      const body = (await req.json()) as Json;
      state = { ...state, ...body };
      return reply(200, {});
    }
    case "POST /__script": {
      const body = (await req.json()) as Scripted;
      scripts.push({ ...body, method: body.method.toUpperCase() });
      return reply(200, {});
    }
  }
  return error(404, "NotFound", "no such control route");
}

const server = Bun.serve({
  port: Number(process.env.PORT ?? 8080),
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/__")) return control(req, url);

    const text = await req.text();
    let body: Json = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    requests.push({
      method: req.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: Object.fromEntries(req.headers),
      body,
    });

    // The real provisioner's Actor extractor: both or nothing.
    if (req.headers.get("authorization") !== `Bearer ${TOKEN}`) {
      return error(401, "Unauthorized", "missing or invalid bearer token");
    }
    const actor = req.headers.get("x-actor-did");
    if (!actor) return error(401, "Unauthorized", "missing X-Actor-Did");

    const i = scripts.findIndex((s) => s.method === req.method && s.path === url.pathname);
    if (i >= 0) {
      const [canned] = scripts.splice(i, 1);
      return reply(canned.status, canned.body);
    }
    if (req.method === "GET" || req.method === "HEAD") return route(req, url, actor, body);

    // The idempotency layer, around every mutating route.
    const key = req.headers.get("idempotency-key")?.trim();
    if (!key) {
      return error(400, "IdempotencyKeyRequired", "mutating requests need an Idempotency-Key header");
    }
    const slot = `${actor}\n${key}`;
    const fingerprint = `${req.method} ${url.pathname}${url.search}\n${text}`;
    const stored = idempotency.get(slot);
    if (stored) {
      if (stored.request !== fingerprint) {
        return error(422, "IdempotencyKeyReused", "this Idempotency-Key was already used for a different request");
      }
      return reply(stored.status, stored.body);
    }
    const res = await route(req, url, actor, body);
    if (res.ok) {
      idempotency.set(slot, { request: fingerprint, status: res.status, body: await res.clone().json() });
    }
    return res;
  },
});

console.log(`fake provisioner listening on ${server.port}`);
