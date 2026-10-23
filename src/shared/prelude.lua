-- Blocks inlined into scripts by `bun run gen`. NOT deployed: this file lives
-- under src/shared/, and only src/at/** mirrors into lua/.
--
-- Blocks are emitted in the order they appear HERE, not the order a script
-- lists them, because Lua requires a local to be declared before any function
-- closing over it. `authority` implies `validate`; `gate` implies `failure`,
-- `access`, `validate` and `authority`; `clickhouse` implies `json`, `failure`
-- and `urlencode`; `provisioner` implies `json` and `failure`;
-- `instance` implies `json`; `jobs` implies `failure`; `release` implies
-- `validate` and `json`; `registry` implies `release`, `authority`,
-- `validate`, `failure` and `json`.
--
-- `gate` is deliberately separable from `failure`: actor.getProfile needs the
-- failure helper but must NOT be admin-gated. It is the endpoint that tells a
-- caller whether they are a member, so gating it on membership would be
-- circular.
--
-- HappyView v3 contract: a script defines `handle(input, ctx)`, and everything
-- per-request -- the caller, script variables, the job -- arrives in `ctx`.
-- The file body runs once when the script loads, before there is any caller,
-- so nothing here reads `ctx` or `env` at file scope. Every block that needs
-- configuration takes `ctx` and reads `ctx.env` inside the function.
--
-- `require` reaches only HappyView's own modules (`internal.*`) and installed
-- library plugins (`happyview.*`), never a sibling file, so sharing this code
-- is still resolved at build time. And the gate is auth on customer data and
-- on provisioning: hand-kept copies of it are a plausible bypass rather than
-- a smell.

-- @block json
local json = require("internal.json")
-- @endblock

-- @block failure
-- Expected conditions are returned, never raised. Lua's `error()` produces a
-- 500 with the error text in front of the caller -- the wrong status for "you
-- are not signed in", and a way to leak whatever the message interpolated.
local function failure(name, message)
  return { error = name, message = message }
end
-- @endblock

-- @block validate
-- Local input checks, run before anything calls out. Each answers a plain
-- boolean and never raises on a non-string.

local UUID = "^" .. string.rep("%x", 8) .. "%-" .. string.rep("%x", 4) .. "%-"
  .. string.rep("%x", 4) .. "%-" .. string.rep("%x", 4) .. "%-" .. string.rep("%x", 12) .. "$"

local function is_uuid(s)
  return type(s) == "string" and s:match(UUID) ~= nil
end

--- atproto DID syntax: `did:<lowercase method>:<identifier>`, at most 2048
--- characters, and the identifier never ends in `:` or `%`.
local function is_did(s)
  return type(s) == "string"
    and #s <= 2048
    and s:match("^did:%l+:[%w%._:%%%-]*[%w%._%-]$") ~= nil
end

-- The provisioner's slug rule, ported from its slug.rs: 3 to 32 characters of
-- `[a-z0-9-]`, starting with a letter, not ending in a hyphen, no `--`, and
-- not reserved. It never normalises: `Alice` is refused, not lowercased.
--
-- RESERVED is slug.rs's always-reserved list. The provisioner also reserves
-- whatever its own configuration adds, which a script cannot see, so it stays
-- the authority: a slug that passes here can still come back InvalidSlug.
local RESERVED = {
  www = true, api = true, admin = true, app = true, mail = true, status = true,
  docs = true, help = true, support = true, billing = true, staff = true,
  happyproto = true, happyview = true, hpy = true, instance = true,
}

--- true, or false and why: "invalid" or "reserved", the same reasons the
--- provisioner's slug check reports.
local function is_slug(s)
  if type(s) ~= "string" or #s < 3 or #s > 32 then return false, "invalid" end
  if not s:match("^[a-z0-9%-]+$") then return false, "invalid" end
  if not s:match("^%l") then return false, "invalid" end
  if s:sub(-1) == "-" then return false, "invalid" end
  if s:find("--", 1, true) then return false, "invalid" end
  if RESERVED[s] then return false, "reserved" end
  return true
end
-- @endblock

-- @block access
-- Access levels that admit. An allowlist, so a level the spaces library adds
-- later, or a value it was never meant to return, refuses rather than admits.
-- Its own block so actor.getProfile can report exactly what the gate would
-- decide without taking the gate.
local MEMBER_ACCESS = { read = true, read_self = true, write = true }
-- @endblock

-- @block authority
-- HappyProto's two spaces, derived from the one script variable that says who
-- HappyProto is. Both are fixed: type at.happyproto.admin or
-- at.happyproto.customers, skey `main`, under HappyProto's own DID.
--
-- The DID is a script variable, not a literal, because it is the part that
-- makes a membership check mean anything: matching on the space TYPE would
-- admit everyone, since any user can create a space of any type and is
-- auto-added to their own as a member. Keeping it server-side means no client
-- can point the gate at a different space.

local ADMIN_SPACE_TYPE = "at.happyproto.admin"
local CUSTOMERS_SPACE_TYPE = "at.happyproto.customers"

--- HAPPYPROTO_DID, or nil when it is unset, empty or not a DID. Callers fail
--- closed on nil: with no authority, nobody is a member of anything.
---
--- It must be HappyProto's own ACCOUNT, never the instance's own service DID.
--- On an instance that publishes a service identity, HappyView anchors every
--- new space under that DID whoever creates it, so with HAPPYPROTO_DID set to
--- it, any signed-in user could create at.happyproto.admin/main first, be
--- its creator, and so be staff.
local function happyproto_did(ctx)
  local did = (ctx.env or {}).HAPPYPROTO_DID
  if is_did(did) then return did end
  return nil
end

--- `at://<HAPPYPROTO_DID>/space/<space_type>/main`, or nil with no valid DID.
local function happyproto_space(ctx, space_type)
  local did = happyproto_did(ctx)
  if not did then return nil end
  return "at://" .. did .. "/space/" .. space_type .. "/main"
end
-- @endblock

-- @block gate
local spaces = require("happyview.spaces")

--- nil when the caller may proceed, else a failure table. Fails closed: a
--- missing caller, a missing or malformed HAPPYPROTO_DID, a space that cannot
--- be read, and no access all refuse.
local function gate_member(ctx, space_type, who)
  if not ctx.caller_did or ctx.caller_did == "" then
    return failure("AuthRequired", "This endpoint requires an authenticated caller.")
  end
  local uri = happyproto_space(ctx, space_type)
  if not uri then
    -- Fail closed: with no authority configured, nobody is a member.
    return failure("Forbidden", "No " .. who .. " space is configured.")
  end
  -- pcall: a spaces call RAISES when the spaces feature is off or the uri is
  -- malformed, and a raise inside the gate is a 500 that locks everyone out.
  -- Fail closed and legibly instead.
  local ok, access = pcall(function()
    return spaces.get(uri):access(ctx.caller_did)
  end)
  if not ok then
    return failure("Forbidden", "The " .. who .. " space is unavailable.")
  end
  if not MEMBER_ACCESS[access] then
    return failure("Forbidden", (who:gsub("^%l", string.upper)) .. "s only.")
  end
  return nil
end

--- Staff: membership of HappyProto's admin space.
local function gate_admin(ctx)
  return gate_member(ctx, ADMIN_SPACE_TYPE, "admin")
end

--- Customers: membership of HappyProto's customers space.
local function gate_customer(ctx)
  return gate_member(ctx, CUSTOMERS_SPACE_TYPE, "customer")
end

--- HappyProto itself: the caller is exactly HAPPYPROTO_DID. For the one
--- endpoint that must work before the admin space exists, so it cannot ask
--- the admin space. Everyone else, a signed-out caller, and an unset or
--- malformed HAPPYPROTO_DID are all Forbidden.
local function gate_owner(ctx)
  local did = happyproto_did(ctx)
  if not did or ctx.caller_did ~= did then
    return failure("Forbidden", "Only HappyProto's own account can do this.")
  end
  return nil
end
-- @endblock

-- @block urlencode
--- Percent-encode a value for a URL query string or path segment: everything
--- but RFC 3986's unreserved characters. A DID goes through this too: a
--- did:web can carry `%` (an encoded port) and `#`, and sent raw the first
--- would be decoded into a different DID and the second would end the URL.
local function url_encode(s)
  return (tostring(s):gsub("[^%w%-%_%.%~]", function(c)
    return string.format("%%%02X", string.byte(c))
  end))
end
-- @endblock

-- @block clickhouse
local http = require("happyview.http")

local CLICKHOUSE_VARS = {
  "HAPPYPROTO_CLICKHOUSE_URL",
  "HAPPYPROTO_CLICKHOUSE_USER",
  "HAPPYPROTO_CLICKHOUSE_PASSWORD",
  "HAPPYPROTO_CLICKHOUSE_DB",
}

-- Lua drops nil values from table constructors, so an unset script variable
-- would silently omit its header and ClickHouse would answer 403
-- "Authentication failed" -- indistinguishable from a wrong password.
-- Name the absent variable instead of guessing later.
local function missing_config(env)
  local absent = {}
  for _, name in ipairs(CLICKHOUSE_VARS) do
    if env[name] == nil or env[name] == "" then
      absent[#absent + 1] = name
    end
  end
  if #absent > 0 then
    return "missing script variable(s): " .. table.concat(absent, ", ")
  end
  return nil
end

--- Rows from ClickHouse, or nil and a message. Reads its configuration from
--- ctx.env on every call.
---
--- Credentials travel as headers, never in the URL, so they stay out of any
--- proxy or access log that records query strings.
---
--- Caller values travel as ClickHouse `param_<name>` arguments paired with
--- `{name:Type}` placeholders in the SQL. Interpolating them into the query
--- text would be an injection; there is no second way to pass a value.
local function query(ctx, sql, params)
  local env = ctx.env or {}
  local absent = missing_config(env)
  if absent then
    return nil, absent
  end
  local url = env.HAPPYPROTO_CLICKHOUSE_URL
  if params then
    local parts = {}
    for key, value in pairs(params) do
      parts[#parts + 1] = "param_" .. key .. "=" .. url_encode(value)
    end
    -- Sorted so a given call always produces the same URL, which keeps logs
    -- and any upstream cache key stable.
    table.sort(parts)
    if #parts > 0 then
      url = url .. "?" .. table.concat(parts, "&")
    end
  end
  -- pcall: happyview.http RAISES when no response comes back at all (DNS,
  -- connection, timeout). A status, 4xx and 5xx included, is a result.
  local ok, response = pcall(http.post, url, {
    headers = {
      ["x-clickhouse-user"] = env.HAPPYPROTO_CLICKHOUSE_USER,
      ["x-clickhouse-key"] = env.HAPPYPROTO_CLICKHOUSE_PASSWORD,
      ["x-clickhouse-database"] = env.HAPPYPROTO_CLICKHOUSE_DB,
    },
    body = sql .. "\nFORMAT JSON",
  })
  if not ok then
    return nil, "telemetry store unreachable"
  end
  if response.status ~= 200 then
    -- Carry the upstream body into the error. ClickHouse explains itself
    -- ("Code: 516 ... Authentication failed", "Code: 497 ... Not enough
    -- privileges"), and discarding that turns a one-line diagnosis into
    -- guesswork. Truncated because an upstream can be verbose. Every caller
    -- of query() is staff-only.
    local detail = tostring(response.body or ""):gsub("%s+", " "):sub(1, 300)
    return nil, "telemetry store answered " .. tostring(response.status)
      .. (detail ~= "" and (": " .. detail) or "")
  end
  local decoded, parsed = pcall(json.decode, response.body)
  if not decoded or type(parsed) ~= "table" or type(parsed.data) ~= "table" then
    return nil, "telemetry store returned an unreadable response"
  end
  return parsed.data
end
-- @endblock

-- @block provisioner
local http = require("happyview.http")
local log = require("internal.logging")

--- status, decoded body -- or nil and a message when no reply came back.
---
--- The body is decoded JSON when it parses, the raw text when it does not,
--- and nil when it is empty. Every call carries the bearer token and the
--- caller as X-Actor-Did, because the provisioner authorises the actor, not
--- the token alone. A mutating call passes `idempotency_key`, so a retry gets
--- the original reply back rather than a second tenant or SlugTaken.
---
--- The transport message is fixed text, safe to show; the cause is logged.
local function provisioner(ctx, method, path, body, idempotency_key)
  local env = ctx.env or {}
  local base, token = env.PROVISIONER_URL, env.PROVISIONER_TOKEN
  if not base or base == "" or not token or token == "" then
    return nil, "provisioner not configured"
  end
  if not ctx.caller_did or ctx.caller_did == "" then
    return nil, "no caller to act as"
  end
  local send = http[string.lower(tostring(method))]
  if not send then
    return nil, "unsupported method " .. tostring(method)
  end

  -- The token travels as a header, never in the URL, so it stays out of any
  -- proxy or access log that records request lines.
  local headers = {
    ["Authorization"] = "Bearer " .. token,
    ["X-Actor-Did"] = ctx.caller_did,
  }
  if idempotency_key ~= nil then
    headers["Idempotency-Key"] = idempotency_key
  end
  local opts = { headers = headers }
  if body ~= nil then
    headers["Content-Type"] = "application/json"
    opts.body = json.encode(body)
  end

  local ok, response = pcall(send, (base:gsub("/+$", "")) .. path, opts)
  if not ok then
    log.warn("provisioner unreachable", { method = method, path = path, error = tostring(response) })
    return nil, "provisioner unreachable"
  end

  local text = response.body
  if text == nil or text == "" then
    return response.status, nil
  end
  local parsed, decoded = pcall(json.decode, text)
  if not parsed then
    return response.status, text
  end
  return response.status, decoded
end

-- Codes the provisioner chose to say to a caller. Each is passed through with
-- its message; anything else becomes Upstream.
local PASSTHROUGH = {
  Forbidden = true,
  NotFound = true,
  InvalidSlug = true,
  SlugTaken = true,
  NotEntitled = true,
  InstanceLimit = true,
  NoCapacity = true,
  OperationInProgress = true,
}

-- Provisioner codes that mean something to a caller under another name:
-- code -> { our code, fixed message? }. With no fixed message the
-- provisioner's own passes through; each of those is a literal in the
-- provisioner, never built from internal state.
--
-- IdempotencyKeyInFlight is a retry arriving while the first request with
-- that key still runs: the same "wait and try again" as OperationInProgress.
-- TenantDeleted reads exactly like a missing instance, as getInstance answers
-- one. NotLive is an instance whose creation has not finished.
local REMAP = {
  IdempotencyKeyInFlight = { "OperationInProgress", "This request is already in progress. Try again shortly." },
  UnknownPlan = { "InvalidRequest" },
  InvalidVersion = { "InvalidRequest" },
  NoChange = { "InvalidRequest" },
  EmptyUpdate = { "InvalidRequest" },
  IdempotencyKeyReused = { "InvalidRequest" },
  TenantDeleted = { "NotFound", "instance not found" },
  NotLive = { "OperationInProgress", "This instance has not finished setting up yet." },
}

--- A provisioner reply mapped to a failure table.
---
--- A known code passes through with its message at any error status:
--- NoCapacity arrives as a 503, and it means the same thing as the 4xx codes.
--- A REMAP code becomes its counterpart. Everything else -- an unknown code,
--- a 500, a body that is not the provisioner's error shape, no reply at all
--- (status nil, `decoded` the transport message) -- is Upstream with a fixed
--- message. The raw body is logged and never returned: it can carry internal
--- detail.
local function provisioner_failure(status, decoded)
  local refusal = type(status) == "number" and status >= 400 and type(decoded) == "table"
  local message = refusal and type(decoded.message) == "string" and decoded.message ~= ""
    and decoded.message or "The provisioner refused the request."
  if refusal and PASSTHROUGH[decoded.error] then
    return failure(decoded.error, message)
  end
  local remap = refusal and REMAP[decoded.error]
  if remap then
    return failure(remap[1], remap[2] or message)
  end
  log.warn("provisioner request failed", { status = status, body = decoded })
  return failure("Upstream", "The provisioner could not complete the request.")
end

--- The caller's own live tenant, as GET /v1/tenants/:id answers it --
--- `{tenant, current_operation}` -- or nil and a failure table. `id` must
--- already be a UUID: it goes into the path. With `include_deleted`, the
--- caller's own deleted tenant comes back too, for deleteInstance's retries;
--- another owner's never does.
---
--- The provisioner hands staff ANY tenant, so ownership is checked here, not
--- trusted to it: a staff member who is also a customer must reach only their
--- own instances through the customer endpoints. Another owner's tenant and a
--- deleted one are both NotFound, in the provisioner's own words, so neither
--- can be told apart from an id that does not exist.
local function owned_tenant(ctx, id, include_deleted)
  local status, body = provisioner(ctx, "GET", "/v1/tenants/" .. id)
  if status ~= 200 or type(body) ~= "table" or type(body.tenant) ~= "table" then
    return nil, provisioner_failure(status, body)
  end
  -- deleted_at is a timestamp string, or JSON null for a live instance.
  local deleted = type(body.tenant.deleted_at) == "string"
  if body.tenant.owner_did ~= ctx.caller_did or (deleted and not include_deleted) then
    return nil, failure("NotFound", "instance not found")
  end
  return body
end
-- @endblock

-- @block instance
-- Provisioner tenants and operations, mapped to the shapes callers see.
-- Every field is listed explicitly, so a field the provisioner adds later is
-- never passed along by accident. Customers never see host_id, image,
-- spec_hash, routed, owner_confirmed_at or the purge timestamps.

local IN_PROGRESS = { pending = true, running = true }

--- `{id, kind, status, step?, error?}`, or nil when there is no operation.
--- Takes either provisioner shape: the tenant list's `current_operation`
--- carries `step`; a full operation carries `steps` and `error_code`.
local function public_operation(op)
  if type(op) ~= "table" or op.id == nil then
    return nil
  end
  local step = op.step
  if type(step) ~= "string" and type(op.steps) == "table" then
    local last = op.steps[#op.steps]
    step = type(last) == "table" and last.name or nil
  end
  local err = op.error
  if type(err) ~= "string" then
    err = op.error_code
  end
  return {
    id = op.id,
    kind = op.kind,
    status = op.status,
    step = type(step) == "string" and step or nil,
    error = type(err) == "string" and err or nil,
  }
end

-- Operations that change a live tenant. While one is in progress, observed
-- lags desired by design, so the state follows desired rather than reading
-- the gap as a failure; the operation field already shows the progress.
local CHANGES = { start = true, stop = true, update = true, upgrade = true }

--- The spec's state table, first match wins:
---   create pending/running  -> provisioning
---   destroy pending/running -> deleting
---   start/stop/update/upgrade pending/running -> desired running or stopped
---   observed running and desired running -> running
---   desired stopped -> stopped
---   otherwise -> failed
local function instance_state(t, op)
  local live = type(op) == "table" and IN_PROGRESS[op.status]
  if live and op.kind == "create" then return "provisioning" end
  if live and op.kind == "destroy" then return "deleting" end
  if live and CHANGES[op.kind] then
    if t.desired_state == "running" then return "running" end
    if t.desired_state == "stopped" then return "stopped" end
  end
  if t.observed_state == "running" and t.desired_state == "running" then return "running" end
  if t.desired_state == "stopped" then return "stopped" end
  return "failed"
end

--- The customer `instance`: `{id, slug, url, plan, version, state, createdAt,
--- operation?}`.
local function public_instance(t, op)
  return {
    id = t.id,
    slug = t.slug,
    url = t.public_url,
    plan = t.plan_id,
    version = t.happyview_version,
    state = instance_state(t, op),
    createdAt = t.created_at,
    operation = public_operation(op),
  }
end

--- The staff `adminInstance`: the customer shape plus ownership, placement
--- and the raw states the derived one came from.
local function admin_instance(t, op, host_name)
  local out = public_instance(t, op)
  out.ownerDid = t.owner_did
  out.hostId = type(t.host_id) == "string" and t.host_id or nil
  out.hostName = host_name
  out.desiredState = t.desired_state
  out.observedState = t.observed_state
  out.routed = t.routed == true
  return out
end
-- @endblock

-- @block jobs
local jobs = require("happyview.jobs")
local log = require("internal.logging")

--- The id of a new `instance.operation` job following the provisioner
--- operation `op`, or nil and a failure table. The job is created as the
--- caller, so only they can read it back with getJob, and it polls the
--- provisioner as them. No `auth`: it never touches their PDS.
---
--- By the time this runs the provisioner has accepted the change, so a
--- failure here leaves an operation nobody is following. The caller gets
--- Upstream and retries with the same idempotencyKey: the provisioner replays
--- its original reply, the same operation comes back, and the retry starts
--- the job this call could not.
---
--- A replayed call always starts a job, so a retry of a call that DID start
--- one gives a second job following the same operation. That is harmless:
--- both read the same operation and end the same way.
local function follow_operation(op)
  if type(op) ~= "table" or type(op.id) ~= "string" then
    log.warn("provisioner reply carried no operation", { operation = op })
    return nil, failure("Upstream", "The provisioner could not complete the request.")
  end
  -- pcall: jobs.create RAISES on a host or database failure.
  local ok, id = pcall(jobs.create, "instance.operation", { operationId = op.id })
  if not ok or type(id) ~= "string" then
    log.warn("could not start the operation job", { operation = op.id, error = tostring(id) })
    return nil, failure("Upstream", "The change was accepted, but its progress cannot be followed. Retry with the same idempotencyKey.")
  end
  return id
end
-- @endblock

-- @block release
-- Checks for the software.release records the registry indexes and the
-- at.happyproto records that make one a HappyView plugin.
--
-- The lexicons cannot say most of what matters here: `requires` is an
-- arbitrary-key map, an interpreter's fields are required only for an
-- interpreter, and HappyView's atproto validation does not enforce a blob's
-- `accept` or `maxSize`. Unenforced here they are enforced nowhere, so the
-- gateway and the indexer both ask these, and what a publisher is refused at
-- the door is exactly what the index refuses later.

local PROJECT = "software.release.project"
local MANIFEST = "software.release.manifest"
local VERSION = "software.release.version"
local CHANNEL = "software.release.channel"
local STATUS = "software.release.status"
local SIDECAR = "at.happyproto.registry.project"
local PUBLICATION = "site.standard.publication"
local DOCUMENT = "site.standard.document"
local ARTIFACT_TYPE = "at.happyproto.plugin.v1"

--- Where registry state lives. Deliberately NOT registered as lexicons:
--- registering a record type makes Jetstream subscribe to it network-wide,
--- and anyone could then publish rows the registry would read as its own.
--- These are written locally under HAPPYPROTO_DID and never leave.
local VERSION_STATE = "at.happyproto.registry.versionState"
local PROJECT_STATE = "at.happyproto.registry.projectState"
local CHANGELOG_CACHE = "at.happyproto.registry.changelogCache"

--- The channels a publisher releases onto. Any name-shaped channel is a valid
--- record, but these are the ones HappyView and hpy follow.
local TRACKS = { latest = true, beta = true, alpha = true }

local PLUGIN_TYPES = { auth = true, library = true, interpreter = true }

local IMAGE_TYPES = {
  ["image/png"] = true, ["image/jpeg"] = true, ["image/webp"] = true,
  ["image/gif"] = true, ["image/avif"] = true,
}

local MAX_PACKAGE = 16777216
local MAX_MANIFEST = 1000000
local MAX_IMAGE = 1000000

--- A project's name: its record key, the first half of a version's and a
--- channel's, and a URL path segment. 1 to 64 lowercase letters, digits and
--- interior hyphens, so it survives all three and a split on `:`.
local function is_project_name(s)
  if type(s) ~= "string" or #s < 1 or #s > 64 then return false end
  return s:match("^[a-z0-9]$") ~= nil or s:match("^[a-z0-9][a-z0-9%-]*[a-z0-9]$") ~= nil
end

--- Semver core plus an optional lowercase prerelease, at most 64 characters.
--- No build metadata, because `+` cannot appear in a record key, and no
--- uppercase, because a version is compared as its key and `Alpha` and
--- `alpha` would be two versions that precede differently.
local function is_release_version(s)
  if type(s) ~= "string" or #s > 64 then return false end
  local major, minor, patch, rest = s:match("^(%d+)%.(%d+)%.(%d+)(.*)$")
  if not major then return false end
  for _, n in ipairs({ major, minor, patch }) do
    if #n > 1 and n:sub(1, 1) == "0" then return false end
  end
  if rest == "" then return true end
  local pre = rest:match("^%-(.+)$")
  if not pre then return false end
  for id in (pre .. "."):gmatch("([^.]*)%.") do
    if id == "" or not id:match("^[0-9a-z%-]+$") then return false end
    -- Semver forbids it, and `01` and `1` would otherwise be two identifiers
    -- that compare equal, leaving their order up to the sort.
    if #id > 1 and id:match("^0[0-9]*$") then return false end
  end
  return true
end

--- A channel record names any name-shaped channel; the tracks are a subset.
local function is_channel_name(s)
  return is_project_name(s)
end

--- `<name>:<rest>` with exactly one colon and a valid name, or nil. The rest
--- is left to the caller, which knows whether it is a version or a channel.
local function split_rkey(rkey)
  if type(rkey) ~= "string" then return nil end
  local name, rest = rkey:match("^([^:]+):([^:]+)$")
  if not name or not is_project_name(name) then return nil end
  return name, rest
end

local function uri_of(did, collection, rkey)
  return "at://" .. did .. "/" .. collection .. "/" .. rkey
end

--- The three parts of a record's at-uri, or nil. Only a DID authority is
--- accepted: a handle in a stored reference would change meaning when the
--- handle moves.
local function parse_uri(uri)
  if type(uri) ~= "string" then return nil end
  local did, collection, rkey = uri:match("^at://([^/]+)/([^/]+)/([^/]+)$")
  if not did or not is_did(did) then return nil end
  return did, collection, rkey
end

--- Semver precedence. Numeric on the core triple; a prerelease sorts below the
--- same core without one, so `3.0.0-alpha.1` is never newer than `3.0.0`; and
--- prerelease identifiers compare one by one, numeric ones as numbers and
--- before any alphanumeric one, so `alpha.10` follows `alpha.2`.
local function version_lt(a, b)
  local function parts(v)
    local major, minor, patch, pre = v:match("^(%d+)%.(%d+)%.(%d+)%-?(.*)$")
    return tonumber(major), tonumber(minor), tonumber(patch), pre
  end
  if type(a) ~= "string" or type(b) ~= "string" then return false end
  local amaj, amin, apat, apre = parts(a)
  local bmaj, bmin, bpat, bpre = parts(b)
  if not amaj or not bmaj then return a < b end
  if amaj ~= bmaj then return amaj < bmaj end
  if amin ~= bmin then return amin < bmin end
  if apat ~= bpat then return apat < bpat end
  if apre == bpre then return false end
  if apre == "" then return false end
  if bpre == "" then return true end

  local function ids(pre)
    local out = {}
    for id in (pre .. "."):gmatch("([^.]*)%.") do out[#out + 1] = id end
    return out
  end
  local aids, bids = ids(apre), ids(bpre)
  for i = 1, math.max(#aids, #bids) do
    local x, y = aids[i], bids[i]
    if x == nil then return true end
    if y == nil then return false end
    if x ~= y then
      local xn = x:match("^%d+$") and tonumber(x)
      local yn = y:match("^%d+$") and tonumber(y)
      if xn and yn then return xn < yn end
      if xn then return true end
      if yn then return false end
      return x < y
    end
  end
  return false
end

--- Whether a version requirement is the dialect we parse, answering a reason
--- when it is not.
---
--- Ranges are Cargo's `VersionReq`, which HappyView's dependency graph already
--- parses, so a registry requirement and the graph agree. Comparators are
--- comma-separated and ANDed. `||` is node-semver, which other ecosystems'
--- tooling produces, so it is refused **by name** rather than left to a
--- parser that reports an unexpected `'|'` and tells a publisher nothing.
--- This is a shape check; Cargo's own parser is the authority at install.
local function range_problem(s)
  if type(s) ~= "string" or s == "" then return "is not a string" end
  if s:find("||", 1, true) then
    return "uses `||`, which Cargo's semver does not support; "
      .. "give one range with comma-separated bounds, or publish one release per major"
  end
  if s == "*" then return nil end
  for part in (s .. ","):gmatch("([^,]*),") do
    local comparator = part:gsub("^[ \t]+", ""):gsub("[ \t]+$", "")
    if comparator == "" then return "has an empty comparator" end
    local version = comparator:match("^[%^~<>=]*[ \t]*(.+)$")
    if not version or version:match("^[0-9]+[0-9A-Za-z%.%-%*]*$") == nil then
      return "has a comparator that is not a version: " .. comparator
    end
  end
  return nil
end

-- Assigned code points that never start a grapheme of their own: combining
-- marks, variation selectors, the zero-width joiner, emoji modifiers and tags.
-- Not a full UAX #29 segmentation, which Lua has no tables for. Every range
-- is one Unicode has assigned as extending, so an unassigned code point counts
-- as a grapheme of its own: the count errs towards more graphemes than there
-- are, and a string it admits is never longer than the lexicon allows.
local function extends(cp)
  return (cp >= 0x0300 and cp <= 0x036F)
    or (cp >= 0x1AB0 and cp <= 0x1ACE)
    or (cp >= 0x1DC0 and cp <= 0x1DFF)
    or (cp >= 0x20D0 and cp <= 0x20F0)
    or (cp >= 0xFE00 and cp <= 0xFE0F)
    or (cp >= 0xFE20 and cp <= 0xFE2F)
    or (cp >= 0x1F3FB and cp <= 0x1F3FF)
    or (cp >= 0xE0020 and cp <= 0xE007F)
    or (cp >= 0xE0100 and cp <= 0xE01EF)
    or cp == 0x200D
end

-- Emoji a zero-width joiner can fuse into the one before it. Anything else
-- after a joiner starts a grapheme of its own, so a run of joiners cannot
-- hide text from the count.
local function pictographic(cp)
  return (cp >= 0x1F000 and cp <= 0x1FAFF)
    or (cp >= 0x2600 and cp <= 0x27BF)
    or (cp >= 0x2B00 and cp <= 0x2BFF)
    or (cp >= 0x2300 and cp <= 0x23FF)
end

--- An approximate grapheme count, or nil for a string that is not UTF-8.
local function graphemes(s)
  if not utf8.len(s) then return nil end
  local count, joined = 0, false
  for _, cp in utf8.codes(s) do
    if joined and pictographic(cp) then
      joined = false
    elseif not extends(cp) then
      joined = false
      count = count + 1
    end
    if cp == 0x200D then joined = true end
  end
  return count
end

--- Why a string breaks a lexicon's limits, or nil. `field` names it in the
--- answer, since a publisher has to find it.
local function text_problem(s, field, max_graphemes, max_bytes)
  if type(s) ~= "string" then return field .. " must be a string" end
  if #s > max_bytes then
    return field .. " is longer than " .. max_bytes .. " bytes"
  end
  local count = graphemes(s)
  if not count then return field .. " is not valid UTF-8" end
  if count > max_graphemes then
    return field .. " is longer than " .. max_graphemes .. " characters"
  end
  return nil
end

--- A whole number of at least `min`. The host's JSON bridge may hand an
--- integral number over as a float, which is still the same count.
local function is_count(x, min)
  local whole = math.type(x) == "integer"
    or (math.type(x) == "float" and x == math.floor(x))
  return whole and x >= min
end

--- A Lua sequence and nothing else, so a map passed where the lexicon wants
--- an array is refused rather than read partially by ipairs.
local function is_list(t)
  if type(t) ~= "table" then return false end
  local count = 0
  for _ in pairs(t) do count = count + 1 end
  return count == #t
end

local function string_list_problem(t, field, max_length)
  if not is_list(t) then return field .. " must be a list" end
  for i, s in ipairs(t) do
    if type(s) ~= "string" then return field .. "[" .. i .. "] must be a string" end
    if #s > max_length then
      return field .. "[" .. i .. "] is longer than " .. max_length .. " characters"
    end
  end
  return nil
end

--- A blob reference as atproto serialises it. The type and size are checked
--- against the claim here; the bytes are checked against the CID when copied.
local function blob_problem(b, field, types, max_size)
  if type(b) ~= "table" or b["$type"] ~= "blob" then return field .. " must be a blob" end
  local link = type(b.ref) == "table" and b.ref["$link"]
  if type(link) ~= "string" or #link > 128 or not link:match("^b[a-z2-7]+$") then
    return field .. " has no CID"
  end
  if not types[b.mimeType] then
    return field .. " has a type that is not accepted: " .. tostring(b.mimeType)
  end
  if not is_count(b.size, 0) then
    return field .. " has no size"
  end
  if b.size > max_size then
    return field .. " is larger than " .. max_size .. " bytes"
  end
  return nil
end

--- A web link a dashboard can render as one. Anything else, `javascript:`
--- above all, is refused rather than handed to a page as an href.
local function is_web_url(s)
  return type(s) == "string" and (s:sub(1, 8) == "https://" or s:sub(1, 7) == "http://")
end

local function image_problem(img, field)
  if type(img) ~= "table" then return field .. " must be an object" end
  local problem = blob_problem(img.image, field .. ".image", IMAGE_TYPES, MAX_IMAGE)
  if problem then return problem end
  for _, side in ipairs({ "width", "height" }) do
    if not is_count(img[side], 1) then
      return field .. "." .. side .. " must be a positive integer"
    end
  end
  if img.alt ~= nil then
    return text_problem(img.alt, field .. ".alt", 300, 3000)
  end
  return nil
end

--- `requires` is an `unknown` field, so the lexicon guarantees nothing about
--- it. Every key is `env:<name>` or a software.release.project at-uri, and
--- every value a range. Keyed by URI rather than DID because identity is
--- (publisher, name) and one publisher may hold many projects.
local function requires_problem(t)
  if t == nil then return nil end
  if type(t) ~= "table" then return "requires must be an object" end
  for key, value in pairs(t) do
    if type(key) ~= "string" then return "requires has a key that is not a string" end
    local is_env = key:sub(1, 4) == "env:" and is_project_name(key:sub(5))
    local did, collection, name = parse_uri(key)
    local is_project = did ~= nil and collection == PROJECT and is_project_name(name)
    if not is_env and not is_project then
      return "requires key is neither env:<name> nor a " .. PROJECT .. " at-uri: " .. key
    end
    local problem = range_problem(value)
    if problem then return "requires[" .. key .. "] " .. problem end
  end
  return nil
end

--- The first key named `checksum` or `url` anywhere in a table. A blob is
--- verified by its CID and fetched from the publisher's PDS, so either would
--- be a second, unverified claim about the same bytes.
local function forbidden_key(t, path)
  for key, value in pairs(t) do
    if key == "checksum" or key == "url" then return path .. key end
    if type(value) == "table" then
      local found = forbidden_key(value, path .. tostring(key) .. ".")
      if found then return found end
    end
  end
  return nil
end

--- Every rule an `at.happyproto.plugin.v1` artifact must meet, the first
--- broken one answered as a sentence naming the field.
local function artifact_problem(a)
  if type(a) ~= "table" then return "the artifact is missing" end
  if a["$type"] ~= nil and a["$type"] ~= ARTIFACT_TYPE then
    return "the artifact is not an " .. ARTIFACT_TYPE
  end
  local forbidden = forbidden_key(a, "")
  if forbidden then
    return forbidden .. " is not allowed; blobs are verified by their CIDs"
  end

  local problem = blob_problem(a.package, "package", { ["application/wasm"] = true }, MAX_PACKAGE)
    or blob_problem(a.manifest, "manifest", { ["application/json"] = true }, MAX_MANIFEST)
  if problem then return problem end

  if a.banner ~= nil then
    problem = image_problem(a.banner, "banner")
    if problem then return problem end
  end
  if a.screenshots ~= nil then
    if not is_list(a.screenshots) then return "screenshots must be a list" end
    if #a.screenshots > 8 then return "screenshots lists more than 8 images" end
    for i, shot in ipairs(a.screenshots) do
      problem = image_problem(shot, "screenshots[" .. i .. "]")
      if problem then return problem end
    end
  end

  if not PLUGIN_TYPES[a.pluginType] then
    return "pluginType is not auth, library or interpreter"
  end
  -- Every plugin type requires API version 2 or later; there is no fallback.
  local major = type(a.apiVersion) == "string" and #a.apiVersion <= 16
    and tonumber(a.apiVersion:match("^(%d+)"))
  if not major or major < 2 then
    return "apiVersion must be \"2\" or later"
  end
  if a.capabilities == nil then
    return "capabilities must be declared, even when empty"
  end
  problem = string_list_problem(a.capabilities, "capabilities", 128)
  if problem then return problem end

  if a.pluginType == "library" then
    if type(a.namespace) ~= "string" or a.namespace == "" then
      return "a library must declare its namespace"
    end
    if #a.namespace > 256 then return "namespace is longer than 256 characters" end
  end

  -- A client builds a file-to-interpreter map from these, so a malformed
  -- entry would claim files no project could name. Mirrors HappyView's
  -- loader, which refuses `json` (a project's lexicons) and a repeat.
  if a.pluginType == "interpreter" then
    if type(a.languageId) ~= "string" or a.languageId == "" then
      return "an interpreter must declare its languageId"
    end
    if #a.languageId > 64 then return "languageId is longer than 64 characters" end
    local list = a.fileExtensions
    if not is_list(list) or #list == 0 then
      return "fileExtensions must list 1 to 8 extensions for an interpreter"
    end
    if #list > 8 then return "fileExtensions lists more than 8 extensions" end
    local seen = {}
    for _, e in ipairs(list) do
      if type(e) ~= "string" or not e:match("^[a-z0-9]+$") or #e > 16 then
        return "fileExtensions entries must be 1 to 16 lowercase letters or digits, without the dot"
      end
      if e == "json" then
        return "fileExtensions cannot claim json, which names a project's lexicons"
      end
      if seen[e] then return "fileExtensions lists " .. e .. " twice" end
      seen[e] = true
    end
  end

  if a.allowedHosts ~= nil then
    problem = string_list_problem(a.allowedHosts, "allowedHosts", 256)
    if problem then return problem end
  end

  problem = requires_problem(a.requires)
  if problem then return problem end

  if type(a.license) ~= "string" or a.license == "" then
    return "license is required"
  end
  if #a.license > 256 then return "license is longer than 256 characters" end

  if type(a.sections) ~= "table" then return "sections.description is required" end
  if a.sections.description == nil then return "sections.description is required" end
  for key in pairs(a.sections) do
    if key ~= "description" and key ~= "installation" and key ~= "security" then
      return "sections." .. tostring(key) .. " is not a section; use description, installation or security"
    end
  end
  for _, name in ipairs({ "description", "installation", "security" }) do
    if a.sections[name] ~= nil then
      problem = text_problem(a.sections[name], "sections." .. name, 2000, 20000)
      if problem then return problem end
    end
  end
  return nil
end

--- Every rule the `at.happyproto.registry.project` sidecar must meet. It is
--- what makes a project a plugin, so it must point at the project and the
--- publication under its own key in its own repo: one pointing elsewhere
--- would let a publisher dress another project up as theirs.
local function sidecar_problem(r, did, name)
  if type(r) ~= "table" then return "the record has no body" end
  if not is_did(did) or not is_project_name(name) then
    return "the record key is not a project name"
  end
  if r.project ~= uri_of(did, PROJECT, name) then
    return "project must be " .. uri_of(did, PROJECT, name)
  end
  local publication = r.publication
  if type(publication) ~= "table" or publication.uri ~= uri_of(did, PUBLICATION, name) then
    return "publication must point at " .. uri_of(did, PUBLICATION, name)
  end
  if type(publication.cid) ~= "string" or publication.cid == "" then
    return "publication has no cid"
  end
  if not PLUGIN_TYPES[r.pluginType] then
    return "pluginType is not auth, library or interpreter"
  end

  if r.keywords ~= nil then
    if not is_list(r.keywords) then return "keywords must be a list" end
    if #r.keywords > 20 then return "keywords lists more than 20 keywords" end
    for i, keyword in ipairs(r.keywords) do
      local problem = text_problem(keyword, "keywords[" .. i .. "]", 32, 320)
      if problem then return problem end
    end
  end

  if not is_list(r.authors) or #r.authors == 0 then
    return "authors must list at least one author"
  end
  for i, author in ipairs(r.authors) do
    local field = "authors[" .. i .. "]"
    if type(author) ~= "table" then return field .. " must be an object" end
    if author.name == "" then return field .. ".name is required" end
    local problem = text_problem(author.name, field .. ".name", 128, 1280)
    if problem then return problem end
    if author.url ~= nil and not is_web_url(author.url) then
      return field .. ".url must be an http or https link"
    end
    if author.email ~= nil and (type(author.email) ~= "string" or #author.email > 320) then
      return field .. ".email must be a string of at most 320 characters"
    end
  end

  if not is_list(r.security) or #r.security == 0 then
    return "security must list at least one contact"
  end
  for i, contact in ipairs(r.security) do
    local field = "security[" .. i .. "]"
    if type(contact) ~= "table" then return field .. " must be an object" end
    local has_url = type(contact.url) == "string" and contact.url ~= ""
    local has_email = type(contact.email) == "string" and contact.email ~= ""
    if not has_url and not has_email then
      return field .. " needs a url or an email"
    end
    if contact.url ~= nil and not is_web_url(contact.url) then
      return field .. ".url must be an http or https link"
    end
    if contact.email ~= nil and (type(contact.email) ~= "string" or #contact.email > 320) then
      return field .. ".email must be a string of at most 320 characters"
    end
  end
  return nil
end

--- The manifest's one plugin artifact. A manifest may carry other
--- ecosystems' artifacts beside it, but two of ours would leave which one to
--- install up to the reader.
local function manifest_artifact(manifest)
  if type(manifest) ~= "table" or not is_list(manifest.artifacts) then
    return nil, "the manifest has no artifacts"
  end
  local found
  for _, a in ipairs(manifest.artifacts) do
    if type(a) == "table" and a["$type"] == ARTIFACT_TYPE then
      if found then return nil, "the manifest carries more than one " .. ARTIFACT_TYPE end
      found = a
    end
  end
  if not found then return nil, "the manifest carries no " .. ARTIFACT_TYPE end
  return found, nil
end

local STATE_SEVERITY = { active = 0, deprecated = 1, unavailable = 2, retired = 3 }

--- The more severe of two states. A project's state applies to every version
--- unless the version's own is worse.
local function worse(a, b)
  if (STATE_SEVERITY[b] or 0) > (STATE_SEVERITY[a] or 0) then return b end
  return a
end

-- What each event type means for installation. Anything else is ignored:
-- ECMA-428 has more event types than a registry needs to act on.
local EVENT_STATE = {
  endOfDevelopment = "deprecated",
  endOfSupport = "deprecated",
  supersededBy = "deprecated",
  endOfDistribution = "unavailable",
  endOfLife = "retired",
}

--- One subject's statuses in rkey order, as events, with the status that
--- decides its state: the last one not withdrawn whose type means something.
local function derive(statuses)
  local sorted = {}
  for _, s in ipairs(statuses or {}) do
    if type(s) == "table" and type(s.record) == "table" and type(s.uri) == "string" then
      sorted[#sorted + 1] = s
    end
  end
  -- A TID sorts by time as a string, so rkey order is creation order.
  table.sort(sorted, function(x, y)
    local _, _, xk = parse_uri(x.uri)
    local _, _, yk = parse_uri(y.uri)
    xk, yk = xk or x.uri, yk or y.uri
    if xk ~= yk then return xk < yk end
    return x.uri < y.uri
  end)

  local withdrawn_by = {}
  for _, s in ipairs(sorted) do
    if s.record.status == "withdrawn" and type(s.record.withdraws) == "string" then
      withdrawn_by[s.record.withdraws] = withdrawn_by[s.record.withdraws] or s.uri
    end
  end

  local events, decider = {}, nil
  for _, s in ipairs(sorted) do
    local r = s.record
    -- Off the firehose these are whatever the publisher wrote, and a view
    -- promises strings.
    local function text(v) if type(v) == "string" then return v end end
    events[#events + 1] = {
      uri = s.uri,
      status = text(r.status),
      kind = text(r.kind),
      reason = text(r.reason),
      supersededBy = text(r.supersededBy),
      withdrawnBy = withdrawn_by[s.uri],
    }
    if EVENT_STATE[r.status] and not withdrawn_by[s.uri] then decider = r end
  end
  return events, decider
end

--- A version's lifecycle, from its own statuses and its project's, each a
--- `{ uri, record }` envelope. The worse of the two states applies, and the
--- status that set it supplies the reason; on a tie the version's own does,
--- since it is the more specific statement.
local function lifecycle(statuses, project_statuses)
  local events, own = derive(statuses)
  local _, inherited = derive(project_statuses)
  local own_state = own and EVENT_STATE[own.status] or "active"
  local inherited_state = inherited and EVENT_STATE[inherited.status] or "active"

  local state, decider = own_state, own
  if STATE_SEVERITY[inherited_state] > STATE_SEVERITY[own_state] then
    state, decider = inherited_state, inherited
  end

  local out = {
    state = state,
    installable = state == "active" or state == "deprecated",
    events = json.to_array(events),
  }
  if decider then
    if type(decider.reason) == "string" then out.reason = decider.reason end
    if type(decider.kind) == "string" then out.kind = decider.kind end
    if decider.status == "supersededBy" and type(decider.supersededBy) == "string" then
      out.supersededBy = decider.supersededBy
    end
  end
  return out
end
-- @endblock

-- @block registry
-- What the registry's queries share: paging, and naming the publisher.

--- The DID an `at-identifier` names, and the handle if one was confirmed.
---
--- A handle is resolved through `happyview.atproto`, whose `resolve_identity`
--- confirms it in both directions -- a one-directional match is how a handle
--- gets impersonated, and here it would let anyone who controls their own DNS
--- show another publisher's plugins under their name. Wrapped in `pcall`
--- because an older `happyview.atproto` has no such export, which reads as an
--- unresolvable identifier rather than an error.
local function resolve_actor(actor)
  if type(actor) ~= "string" or actor == "" then return nil end
  if is_did(actor) then return actor, nil end

  local atproto = require("happyview.atproto")
  local ok, identity = pcall(atproto.resolve_identity, actor)
  if not ok or type(identity) ~= "table" or not is_did(identity.did) then
    return nil
  end
  return identity.did, identity.handle
end

--- The handle a DID's document claims, when it is confirmed both ways, or nil.
---
--- Best-effort and deliberately separate from `resolve_actor`: a lookup that
--- fails must not turn an indexed project into a refusal, so this answers nil
--- where `resolve_actor` answers "no such publisher".
local function handle_for(did)
  if not is_did(did) then return nil end

  local atproto = require("happyview.atproto")
  local ok, identity = pcall(atproto.resolve_identity, did)
  if not ok or type(identity) ~= "table" then return nil end
  return identity.handle
end

--- The paging arguments a registry query accepts, clamped. A caller-supplied
--- limit is never trusted as a page size.
local function registry_page(input)
  local limit = tonumber(input.limit) or 50
  if limit < 1 then limit = 1 end
  if limit > 100 then limit = 100 end
  return limit, input.cursor
end
-- @endblock
