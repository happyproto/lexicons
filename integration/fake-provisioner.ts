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
 *   POST /__state    seed { tenants?, operations?, plans?, hosts?, staff?, instanceLimit?,
 *                    entitlementMode?, invites? }. invites are rows as the
 *                    real table holds them, token_hash included. entitlementMode is "invite" (the
 *                    default, as production runs: anyone may create and
 *                    change) or "staff" (entitlement.rs today: only staff may,
 *                    everyone else gets 403 NotEntitled). customDomains turns
 *                    the domain routes on (CUSTOM_DOMAINS_ENABLED; off by
 *                    default, as production runs until it is switched on).
 *                    domains are rows: the API's Domain shape plus tenant_id,
 *                    and removed: true for one that is gone.
 *                    autoscale is GET /v1/autoscale's answer; hostRequests
 *                    are rows as GET /v1/host-requests/:id answers them,
 *                    events included.
 *   POST /__script   queue one canned reply { method, path, status, body }; the
 *                    next request matching method and path gets it, once.
 *                    With { drop: true } instead, that request gets no reply:
 *                    the connection closes, as a dead provisioner's would.
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

type Scripted = { method: string; path: string; status: number; body: Json; drop?: boolean };

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
    hosts: [] as Json[],
    staff: [] as string[],
    instanceLimit: 3,
    entitlementMode: "invite" as "invite" | "staff",
    invites: [] as Json[],
    customDomains: false,
    domains: [] as Json[],
    autoscale: {
      enabled: true,
      paused: false,
      paused_by: null,
      paused_at: null,
      max_hosts: 3,
      hosts: 1,
      in_flight: 0,
      blocked_by: null,
      cost_eur: "13.10",
      thresholds: { free_memory_mb: 2048, free_disk_gb: 50, sustain_secs: 600, cooldown_secs: 21600 },
      low_since: null,
      cooldown_until: null,
      current: { free_memory_mb: 3072, free_disk_gb: 120 },
    } as Json,
    hostRequests: [] as Json[],
  };
}

/**
 * The autoscaler's staff routes, as api/autoscale.rs answers them: the
 * overview and its pause toggle, and host requests with their timelines.
 * Retry and cancel apply the real state rules, not the workflows behind them.
 */
function scalerRoute(req: Request, url: URL, parts: string[], body: Json, actor: string): Response {
  const [, resource, id, verb] = parts;
  if (resource === "autoscale" && parts.length === 2) {
    if (req.method === "GET") return reply(200, state.autoscale);
    if (req.method === "PATCH") {
      if (typeof body?.paused !== "boolean") return error(422, "InvalidBody", "paused must be a boolean");
      const a = state.autoscale;
      if (a.paused !== body.paused) {
        a.paused = body.paused;
        a.paused_by = body.paused ? actor : null;
        a.paused_at = body.paused ? new Date().toISOString() : null;
      }
      return reply(200, a);
    }
  }
  if (resource !== "host-requests") return error(404, "NotFound", "no such route");

  const summary = ({ events: _, ...r }: Json) => r;
  if (req.method === "GET" && parts.length === 2) {
    const limit = Number(url.searchParams.get("limit") ?? 50);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      return error(400, "InvalidQuery", "limit must be from 1 to 200");
    }
    const newest = [...state.hostRequests].sort(
      (a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id),
    );
    const before = url.searchParams.get("before");
    const from = before === null ? 0 : newest.findIndex((r) => r.id === before) + 1;
    const page = before !== null && from === 0 ? [] : newest.slice(from, from + limit);
    return reply(200, { requests: page.map(summary) });
  }

  const r = state.hostRequests.find((x) => x.id === id);
  if (!r) return error(404, "NotFound", "host request not found");
  const at = new Date().toISOString();
  if (req.method === "GET" && parts.length === 3) return reply(200, { request: r });
  if (req.method === "POST" && verb === "retry") {
    if (r.state !== "failed") return error(409, "NotRetryable", "only a failed request can be retried");
    r.events.push({ at, kind: "retried", message: `Retried by ${actor}`, detail: { actor_did: actor, previous_error: r.error } });
    Object.assign(r, { state: "requested", error: null, current_step: null, finished_at: null, dispatched_at: at, updated_at: at });
    return reply(200, { request: r });
  }
  if (req.method === "POST" && verb === "cancel") {
    if (r.state === "registered" || r.state === "cancelled") {
      return error(409, "NotCancellable", `${r.name} is ${r.state}`);
    }
    if (body?.confirm !== r.name) return error(400, "ConfirmationMismatch", `type ${r.name} to cancel it`);
    r.events.push({ at, kind: "cancel_requested", message: `Cancel requested by ${actor}`, detail: { actor_did: actor, from: r.state } });
    Object.assign(r, { state: "cancelling", dispatched_at: at, updated_at: at });
    return reply(200, { request: r });
  }
  return error(404, "NotFound", "no such route");
}

const sha256 = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");

/** An invite as api/invites.rs serialises it: never its token hash. */
function inviteRow(i: Json): Json {
  const { token_hash: _, ...row } = i;
  const status = i.redeemed_did ? "redeemed" : Date.parse(i.expires_at) <= Date.now() ? "expired" : "pending";
  return { ...row, status };
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

/**
 * A host as hosts::list serialises it: every column, plus what its tenants
 * hold, by placement.rs's rules. Memory is held by tenants not deleted; disk
 * until a tenant is purged. Free capacity is what is left, and can go
 * negative; a plan fits where its memory and disk both do, on an active host.
 */
function hostUsage(h: Json): Json {
  const plan = (t: Json) => state.plans.find((p) => p.id === t.plan_id) ?? {};
  const here = state.tenants.filter((t) => t.host_id === h.id);
  const live = here.filter((t) => !t.deleted_at);
  const reservedMemory = live.reduce((sum, t) => sum + (plan(t).memory_mb ?? 0), 0);
  const reservedDisk = here.filter((t) => !t.purged_at).reduce((sum, t) => sum + (plan(t).disk_gb ?? 0), 0);
  const free = { memory: h.memory_mb - reservedMemory, disk: h.disk_gb - reservedDisk };
  return {
    ...h,
    tenant_count: live.length,
    reserved_memory_mb: reservedMemory,
    reserved_disk_gb: reservedDisk,
    free_memory_mb: free.memory,
    free_disk_gb: free.disk,
    placeable_plans: h.state === "active" ? activePlans().filter((p) => fits(free, p)).map((p) => p.id) : [],
  };
}

/** Plans open for new instances, smallest first, as placement::active_plans orders them. */
function activePlans(): Json[] {
  return state.plans
    .filter((p) => p.active !== false)
    .sort((a, b) => a.memory_mb - b.memory_mb || String(a.id).localeCompare(String(b.id)));
}

const fits = (free: { memory: number; disk: number }, plan: Json) =>
  free.memory >= plan.memory_mb && free.disk >= plan.disk_gb;

/** GET /v1/hosts: every host, and the active plans no active host has room for. */
function hostsList(): Json {
  const hosts = [...state.hosts].sort((a, b) => a.name.localeCompare(b.name)).map(hostUsage);
  const active = hosts.filter((h) => h.state === "active");
  const unplaceable = activePlans()
    .filter((p) => !active.some((h) => fits({ memory: h.free_memory_mb, disk: h.free_disk_gb }, p)))
    .map((p) => p.id);
  return { hosts, unplaceable_plans: unplaceable };
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

/** entitlement::check_create and check_change, under the seeded mode. */
function entitled(staff: boolean): boolean {
  return state.entitlementMode === "invite" || staff;
}

function notEntitled(): Response {
  return error(403, "NotEntitled", "this account cannot do that yet");
}

/** A domain row as api/domains.rs serialises it: the Domain shape alone. */
function domainRow(d: Json): Json {
  const { tenant_id: _, removed: __, last_verify_at: ___, ...row } = d;
  return row;
}

/** A tenant's live domains: pending, verified or lapsed. */
function liveDomains(tenantId: string): Json[] {
  return state.domains.filter((d) => d.tenant_id === tenantId && !d.removed);
}

/**
 * The /v1/tenants/:id/domains routes, with the rulings T4 settled: 404
 * NotAvailable for non-staff while the flag is off, one live domain per
 * instance, DELETE answering {operation} (null unless routing changed).
 */
function domainsRoute(req: Request, parts: string[], body: Json, actor: string, staff: boolean): Response {
  if (!state.customDomains && !staff) {
    return error(404, "NotAvailable", "custom domains are not available yet");
  }
  const [, , id, , domainId, verb] = parts;
  const tenant = state.tenants.find((t) => t.id === id);
  if (!tenant || !(staff || tenant.owner_did === actor) || tenant.deleted_at) {
    return error(404, "NotFound", "instance not found");
  }
  const base = `${tenant.slug}.hpy.at`;

  if (req.method === "GET" && parts.length === 4 && parts[3] === "domains") {
    const domains = liveDomains(tenant.id);
    return reply(200, {
      platform: { hostname: base, primary: !domains.some((d) => d.primary) },
      domains: domains.map(domainRow),
      requestedPrimary: tenant.requested_primary ?? null,
    });
  }

  // PUT primary-domain, with T12's checks in its order. The fake has no
  // versions, so VersionTooOld is scripted where a test needs it.
  if (req.method === "PUT" && parts.length === 4 && parts[3] === "primary-domain") {
    const hostname = typeof body?.hostname === "string" ? body.hostname.trim().toLowerCase() : "";
    if (!/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(hostname)) {
      return error(400, "InvalidHostname", "that is not a hostname");
    }
    const live = liveDomains(tenant.id);
    const current = tenant.requested_primary ?? live.find((d) => d.primary)?.hostname ?? base;
    if (hostname !== base) {
      const domain = live.find((d) => d.hostname === hostname);
      if (!domain || domain.state !== "verified") {
        return error(409, "NotVerified", "that is not a verified domain of this instance");
      }
      if (domain.serving !== "live") {
        return error(409, "CertificateNotReady", "that domain is not serving over HTTPS yet");
      }
    }
    if (hostname === current) return reply(200, { operation: null });
    const livePrimary = live.find((d) => d.primary)?.hostname ?? base;
    tenant.requested_primary = hostname === livePrimary ? null : hostname;
    return reply(202, { operation: enqueue(tenant.id, "update", { reason: "primary-domain" }, actor) });
  }

  if (req.method === "POST" && parts.length === 4) {
    const hostname = typeof body?.hostname === "string" ? body.hostname.trim().toLowerCase() : "";
    if (!/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(hostname)) {
      return error(400, "InvalidHostname", "that is not a hostname");
    }
    if (["hpy.at", "happyproto.at"].some((p) => hostname === p || hostname.endsWith(`.${p}`))) {
      return error(400, "PlatformHostname", "that hostname belongs to HappyProto");
    }
    const live = liveDomains(tenant.id);
    if (live.some((d) => d.hostname === hostname)) {
      return error(409, "DomainExists", "this instance already has that domain");
    }
    if (live.length >= 1) return error(409, "DomainLimit", "this instance already has a custom domain");
    const token = crypto.randomUUID().replaceAll("-", "").slice(0, 26);
    const now = new Date();
    const domain = {
      id: crypto.randomUUID(),
      tenant_id: tenant.id,
      hostname,
      state: "pending",
      primary: false,
      records: [
        { type: "TXT", name: `_happyproto.${hostname}`, value: `happyproto-verify=${token}` },
        { type: "CNAME", name: hostname, value: base, alt: { type: "A", value: "2.29.59.39" } },
      ],
      checks: null,
      serving: "off",
      lapsesAt: null,
      expiresAt: new Date(now.getTime() + 7 * 86_400_000).toISOString(),
      createdAt: now.toISOString(),
      verifiedAt: null,
    };
    state.domains.push(domain);
    return reply(201, domainRow(domain));
  }

  const domain = state.domains.find((d) => d.id === domainId && d.tenant_id === tenant.id && !d.removed);
  if (!domain) return error(404, "NotFound", "domain not found");

  if (req.method === "POST" && parts.length === 6 && verb === "verify") {
    if (domain.last_verify_at && Date.now() - domain.last_verify_at < 10_000) {
      return error(429, "TooSoon", "this domain was checked moments ago");
    }
    domain.last_verify_at = Date.now();
    domain.checks = { ownership: "missing", pointing: "error", checkedAt: new Date().toISOString() };
    return reply(200, domainRow(domain));
  }

  if (req.method === "DELETE" && parts.length === 5) {
    if (domain.primary || domain.hostname === tenant.requested_primary) {
      return error(409, "DomainIsPrimary", "make the platform subdomain primary first");
    }
    domain.removed = true;
    if (domain.state !== "verified") return reply(200, { operation: null });
    return reply(202, { operation: enqueue(tenant.id, "update", { reason: "domains" }, actor) });
  }

  return error(404, "NotFound", `the fake provisioner has no route for ${req.method} ${parts.join("/")}`);
}

/** POST /v1/tenants, tenants::create's checks in its order. */
function createTenant(body: Json, actor: string, staff: boolean): Response {
  if (!body || typeof body !== "object") return error(400, "InvalidRequest", "body must be JSON");
  if (!(staff || body.owner_did === actor)) {
    return error(403, "Forbidden", "you can only create instances for yourself");
  }
  if (!entitled(staff)) return notEntitled();
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
    version_label: null,
    available_version: null,
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

/**
 * POST /v1/tenants/:id/upgrade: only to the release the tenant's
 * available_version offers, as the provisioner refuses anything else.
 */
function upgradeTenant(tenant: Json, body: Json, actor: string): Response {
  const offered = tenant.available_version;
  if (!offered || body?.version !== offered.version) {
    return error(409, "UpgradeUnavailable", "that release is not on offer for this instance");
  }
  const params = { version: { from: tenant.happyview_version, to: offered.version } };
  const operation = enqueue(tenant.id, "upgrade", params, actor);
  tenant.happyview_version = offered.version;
  tenant.version_label = offered.label ?? null;
  tenant.available_version = null;
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

  if (resource === "invites" && parts.length === 2 && (req.method === "GET" || req.method === "POST")) {
    if (!staff) return error(403, "Forbidden", "staff only");
    if (req.method === "GET") return reply(200, { invites: [...state.invites].reverse().map(inviteRow) });
    const batch = body?.invites;
    if (!Array.isArray(batch) || batch.length < 1 || batch.length > 50) {
      return error(400, "InvalidInvite", "invites must hold 1 to 50 invites");
    }
    const rows: Json[] = [];
    for (const i of batch) {
      if (typeof i?.email !== "string" || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(i.email.trim())) {
        return error(400, "InvalidInvite", "email must be an email address");
      }
      if (typeof i.token !== "string" || !/^[0-9a-f]{1,128}$/i.test(i.token)) {
        return error(400, "InvalidInvite", "token must be an invite token");
      }
      const hash = sha256(i.token);
      if (state.invites.some((x) => x.token_hash === hash) || rows.some((x) => x.token_hash === hash)) {
        return error(409, "InviteExists", "an invite in this batch is already recorded");
      }
      rows.push({
        id: crypto.randomUUID(),
        email: i.email.trim().toLowerCase(),
        token_hash: hash,
        created_by: actor,
        created_at: new Date().toISOString(),
        expires_at: i.expires_at,
        redeemed_did: null,
        redeemed_at: null,
      });
    }
    state.invites.push(...rows);
    return reply(201, { invites: rows.map(inviteRow) });
  }

  if (req.method === "POST" && resource === "invites" && id === "redeem" && parts.length === 3) {
    if (typeof body?.token !== "string" || !/^[0-9a-f]{1,128}$/i.test(body.token)) {
      return error(400, "InvalidInvite", "token must be an invite token");
    }
    const invite = state.invites.find((x) => x.token_hash === sha256(body.token));
    if (!invite) return error(404, "NotFound", "no invite has this token");
    if (invite.redeemed_did && invite.redeemed_did !== actor) {
      return error(409, "InviteUsed", "this invite was redeemed by another account");
    }
    if (!invite.redeemed_did) {
      invite.redeemed_did = actor;
      invite.redeemed_at = new Date().toISOString();
    }
    return reply(200, { invite: { id: invite.id, redeemed_at: invite.redeemed_at } });
  }

  if (resource === "autoscale" || resource === "host-requests") {
    if (!staff) return error(403, "Forbidden", "staff only");
    return scalerRoute(req, url, parts, body, actor);
  }

  if (req.method === "GET" && resource === "hosts" && parts.length === 2) {
    if (!staff) return error(403, "Forbidden", "staff only");
    return reply(200, hostsList());
  }

  if (req.method === "GET" && resource === "admin" && parts.length === 3) {
    if (!staff) return error(403, "Forbidden", "staff only");
    const bad = (m: string) => error(400, "InvalidRange", m);
    if (id === "capacity") {
      return reply(200, { latest: null, trend: [], collections: [], tenants: [] });
    }
    if (id === "usage") {
      const grain = url.searchParams.get("grain") ?? "hour";
      if (grain !== "hour" && grain !== "day") return bad("`grain` must be `hour` or `day`");
      const asked = url.searchParams.get("tenant");
      if (!state.tenants.some((t) => t.id === asked)) return error(404, "NotFound", "no such tenant");
      return reply(200, { tenant: asked, grain, rows: [], gaps: [] });
    }
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

  // api/operations.rs `list`: newest first, keyset on (created_at, id), a
  // `before` from another tenant ends the list.
  if (req.method === "GET" && resource === "tenants" && id && parts[3] === "operations" && parts.length === 4) {
    const tenant = state.tenants.find((t) => t.id === id);
    if (!tenant || !can(tenant.owner_did)) return error(404, "NotFound", "instance not found");
    const limit = Number(url.searchParams.get("limit") ?? "20");
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      return error(400, "InvalidRequest", "limit must be between 1 and 100");
    }
    const key = (o: Json) => `${o.created_at}\u0000${o.id}`;
    const mine = state.operations
      .filter((o) => o.tenant_id === id)
      .sort((a, b) => (key(a) < key(b) ? 1 : key(a) > key(b) ? -1 : 0));
    const before = url.searchParams.get("before");
    let rest = mine;
    if (before) {
      const at = mine.findIndex((o) => o.id === before);
      rest = at === -1 ? [] : mine.slice(at + 1);
    }
    const page = rest.slice(0, limit);
    const cursor = rest.length > limit ? page[page.length - 1].id : null;
    return reply(200, { operations: page, cursor });
  }

  if (req.method === "POST" && resource === "tenants" && parts.length === 2) {
    return createTenant(body, actor, staff);
  }

  // GET /v1/tenants/:id/usage: the owner's (or staff's) read of usage/admin.
  if (req.method === "GET" && resource === "tenants" && id && parts[3] === "usage" && parts.length === 4) {
    const tenant = state.tenants.find((t) => t.id === id);
    if (!tenant || !can(tenant.owner_did)) return error(404, "NotFound", "instance not found");
    const grain = url.searchParams.get("grain") ?? "hour";
    if (grain !== "hour" && grain !== "day") return error(400, "InvalidRange", "`grain` must be `hour` or `day`");
    return reply(200, { tenant: id, grain, rows: [], gaps: [] });
  }

  if (resource === "tenants" && id && (parts[3] === "domains" || parts[3] === "primary-domain")) {
    return domainsRoute(req, parts, body, actor, staff);
  }

  if (resource === "tenants" && id) {
    const verb = parts[3];
    const known =
      (req.method === "PATCH" && parts.length === 3) ||
      (req.method === "DELETE" && parts.length === 3) ||
      (req.method === "POST" && parts.length === 4 && (verb === "start" || verb === "stop" || verb === "upgrade"));
    if (known) {
      // tenants::update and ::upgrade check entitlement before they load the tenant.
      if ((req.method === "PATCH" || verb === "upgrade") && !entitled(staff)) return notEntitled();
      const tenant = state.tenants.find((t) => t.id === id);
      if (!tenant || !can(tenant.owner_did)) return error(404, "NotFound", "instance not found");
      if (tenant.desired_state === "deleted") {
        return error(409, "TenantDeleted", "this instance has been deleted");
      }
      // tenants::require_live, ahead of ops::enqueue's in-progress check.
      if (req.method !== "DELETE" && !tenant.routed) {
        return error(409, "NotLive", "this instance has not gone live yet; retry its creation");
      }
      if (activeOperation(tenant.id)) {
        return error(409, "OperationInProgress", "an operation is already in progress for this instance");
      }
      if (req.method === "PATCH") return updateTenant(tenant, body, actor);
      if (verb === "upgrade") return upgradeTenant(tenant, body, actor);
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
      if (canned.drop) {
        // Close the connection with nothing sent: the caller sees no reply.
        server.timeout(req, 1);
        await Bun.sleep(2_000);
      }
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
