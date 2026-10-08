/**
 * A stand-in for the provisioner, serving the routes the scripts call with
 * the provisioner's real shapes (crates/provisioner/src/api/*.rs).
 *
 * It enforces what the real one enforces about the caller -- the bearer
 * token, an X-Actor-Did, owner scoping, and staff seeing everything -- so a
 * script that forgets to scope a call is caught here, not in production.
 *
 * Control routes, all under /__:
 *   POST /__state    seed { tenants?, operations?, plans?, staff?, instanceLimit? }
 *   POST /__script   queue one canned reply { method, path, status, body }; the
 *                    next request matching method and path gets it, once
 *   GET  /__requests every request received since the last reset
 *   POST /__reset    clear state, scripts and requests
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

const TOKEN = process.env.PROVISIONER_TOKEN ?? "integration-provisioner-token";

const DEFAULT_PLANS = [
  { id: "small", name: "Small", memory_mb: 512, cpu_millis: 500, disk_gb: 5 },
  { id: "medium", name: "Medium", memory_mb: 1024, cpu_millis: 1000, disk_gb: 10 },
];

let state = fresh();
let scripts: Scripted[] = [];
let requests: Recorded[] = [];

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

async function route(req: Request, url: URL, actor: string): Promise<Response> {
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
    return reply(200, { operation: op });
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
    return route(req, url, actor);
  },
});

console.log(`fake provisioner listening on ${server.port}`);
