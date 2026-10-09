-- Blocks inlined into scripts by `bun run gen`. NOT deployed: this file lives
-- under src/shared/, and only src/at/** mirrors into lua/.
--
-- Blocks are emitted in the order they appear HERE, not the order a script
-- lists them, because Lua requires a local to be declared before any function
-- closing over it. `authority` implies `validate`; `gate` implies `failure`,
-- `access`, `validate` and `authority`; `clickhouse` implies `json`, `failure`
-- and `urlencode`; `provisioner` implies `json` and `failure`;
-- `instance` implies `json`; `jobs` implies `failure`.
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

-- @block plugin
-- Checks for the `at.happyproto.plugin.*` records the registry indexes.
--
-- Three constraints the lexicons cannot express live here, because a lexicon
-- cannot require one of two fields and cannot type an arbitrary-key map: an
-- artifact must carry `blob` or `url`, `extensions` must actually carry our
-- manifest, and `requires` keys and ranges have to be read. Unenforced here
-- they are enforced nowhere.

--- Where registry state lives. Deliberately NOT registered as a lexicon:
--- registering a record type makes Jetstream subscribe to it network-wide,
--- and anyone could then publish rows the registry would read as its own.
--- These are written locally under HAPPYPROTO_DID and never leave.
local RELEASE_STATE = "at.happyproto.registry.releaseState"
local PACKAGE_STATE = "at.happyproto.registry.packageState"

--- A package slug. It is the profile's record key and the first half of a
--- release's, so it must survive a record key, a URL path segment, and a
--- split on `:` -- which is why a colon is not allowed in it.
local function is_plugin_slug(s)
  return type(s) == "string"
    and #s >= 1
    and #s <= 128
    and s:match("^%a[%w%-%.]*$") ~= nil
end

--- Semver 2.0 without build metadata. `+` cannot appear in an atproto record
--- key, so a version carrying it could never equal its own rkey half.
--- Prerelease identifiers are allowed; a leading `v` is not.
local function is_plugin_version(s)
  if type(s) ~= "string" or #s > 256 or s:find("+", 1, true) then return false end
  local core, pre = s:match("^(%d+%.%d+%.%d+)%-?([%w%.%-]*)$")
  if not core then return false end
  if pre ~= "" and pre:match("^[%w%.%-]+$") == nil then return false end
  return true
end

--- A release's record key is `<slug>:<version>`. Answers both halves, or nil
--- for anything that is not exactly that shape.
local function split_release_rkey(rkey)
  if type(rkey) ~= "string" then return nil end
  local slug, version = rkey:match("^([^:]+):(.+)$")
  if not slug or not is_plugin_slug(slug) or not is_plugin_version(version) then
    return nil
  end
  return slug, version
end

--- Whether a version-requirement string is the dialect we parse, answering a
--- reason when it is not.
---
--- Ranges are Cargo's `VersionReq`, which `plugin::graph` already parses
--- `dependencies` with, so a registry requirement and the dependency graph
--- agree. Comparators are comma-separated and ANDed. `||` is node-semver,
--- which FAIR and EmDash tooling would produce, so it is refused **by name**
--- rather than left to a parser that reports an unexpected `'|'` and tells a
--- publisher nothing. This is a shape check; Cargo's own parser is the
--- authority at install time.
local function semver_range_problem(s)
  if type(s) ~= "string" or s == "" then return "is not a string" end
  if s:find("||", 1, true) then
    return "uses `||`, which Cargo's semver does not support; "
      .. "give one range with comma-separated bounds, or publish one release per major"
  end
  if s == "*" then return nil end
  for part in (s .. ","):gmatch("([^,]*),") do
    local comparator = part:gsub("^%s+", ""):gsub("%s+$", "")
    if comparator == "" then return "has an empty comparator" end
    local version = comparator:match("^[%^~<>=]*%s*(.+)$")
    if not version or version:match("^%d+[%w%.%-%*]*$") == nil then
      return "has a comparator that is not a version: " .. comparator
    end
  end
  return nil
end

--- `requires` is an `unknown` field, so the lexicon guarantees only that it
--- is an object. Every key must be `env:happyview` or a profile AT URI, and
--- every value a range. Keyed by AT URI rather than DID because identity is
--- (publisher, slug) and one publisher may hold many packages.
local function requires_problem(t)
  if t == nil then return nil end
  if type(t) ~= "table" then return "requires must be an object" end
  for key, value in pairs(t) do
    if type(key) ~= "string" then return "requires has a non-string key" end
    local is_env = key:match("^env:[%w%-%.]+$") ~= nil
    local did, slug = key:match("^at://([^/]+)/at%.happyproto%.plugin%.profile/(.+)$")
    local is_package = did ~= nil and is_did(did) and is_plugin_slug(slug)
    if not is_env and not is_package then
      return "requires key is neither env:* nor a profile AT URI: " .. key
    end
    local problem = semver_range_problem(value)
    if problem then return "requires[" .. key .. "] " .. problem end
  end
  return nil
end

--- An artifact must name its bytes somehow. The lexicon requires `checksum`
--- and can require neither `blob` nor `url`, since it cannot express "one of
--- these two".
local function artifact_problem(a)
  if type(a) ~= "table" then return "artifact is missing" end
  if type(a.checksum) ~= "string" or a.checksum == "" then
    return "artifact has no checksum"
  end
  if a.blob == nil and (type(a.url) ~= "string" or a.url == "") then
    return "artifact carries neither a blob nor a url"
  end
  return nil
end

local PLUGIN_TYPES = { auth = true, library = true, interpreter = true }

--- The manifest, which `extensions` carries under our NSID. `extensions` is
--- `unknown` too, so its presence and shape are ours to check.
local function release_extension_problem(extensions)
  if type(extensions) ~= "table" then return "extensions is missing" end
  local ext = extensions["at.happyproto.plugin.releaseExtension"]
  if type(ext) ~= "table" then
    return "extensions carries no at.happyproto.plugin.releaseExtension"
  end
  if not PLUGIN_TYPES[ext.pluginType] then
    return "pluginType is not auth, library or interpreter"
  end
  -- Every plugin type requires api_version 2 or later; there is no fallback.
  local major = tonumber(tostring(ext.apiVersion or ""):match("^(%d+)"))
  if not major or major < 2 then
    return "apiVersion must be \"2\" or later"
  end
  if type(ext.capabilities) ~= "table" then
    return "capabilities must be declared, even when empty"
  end
  if ext.pluginType == "library" and type(ext.namespace) ~= "string" then
    return "a library must declare its namespace"
  end
  if ext.pluginType == "interpreter" and type(ext.languageId) ~= "string" then
    return "an interpreter must declare its languageId"
  end
  return nil
end

--- The state row's key. One row per (publisher, package, version), under our
--- own DID, so a publisher cannot collide with it.
local function release_state_rkey(did, slug, version)
  return did .. ":" .. slug .. ":" .. version
end
-- @endblock

-- @block registry
-- Shaping the registry's two views, and ordering versions.
--
-- The views keep the publisher's record and the registry's own state apart:
-- `record` is what was published, verbatim, and `status` is ours. Mixing them
-- would make it impossible to hand a client back what the publisher signed.

local PROFILE_COLLECTION = "at.happyproto.plugin.profile"
local RELEASE_COLLECTION = "at.happyproto.plugin.release"

--- Semver precedence, enough to pick a latest. Numeric on the core triple,
--- and a prerelease sorts BELOW the same core without one, which is the rule
--- that keeps `3.0.0-alpha.1` from being "latest" over `3.0.0`.
local function plugin_version_lt(a, b)
  local function parts(v)
    local major, minor, patch, pre = v:match("^(%d+)%.(%d+)%.(%d+)%-?(.*)$")
    return tonumber(major), tonumber(minor), tonumber(patch), pre
  end
  local amaj, amin, apat, apre = parts(a)
  local bmaj, bmin, bpat, bpre = parts(b)
  if not amaj or not bmaj then return a < b end
  if amaj ~= bmaj then return amaj < bmaj end
  if amin ~= bmin then return amin < bmin end
  if apat ~= bpat then return apat < bpat end
  if apre == bpre then return false end
  if apre == "" then return false end
  if bpre == "" then return true end
  return apre < bpre
end

--- A release as the contract describes it. `status` comes from our state row;
--- a release with no row has not been seen by the indexer, which is reported
--- as `unknown` rather than guessed at.
local function release_view(envelope, state)
  return {
    uri = envelope.uri,
    cid = envelope.cid,
    record = envelope.record,
    status = (state and state.status) or "unknown",
    indexedAt = envelope.indexed_at,
  }
end

--- A package, with the highest `active` version if it has one. `handle` is
--- deliberately absent: no library available to a script resolves a DID to a
--- handle, so populating it would mean inventing one. It is optional in the
--- lexicon for that reason, and arrives when `happyview.atproto` grows a
--- resolver.
local function package_view(envelope, state, latest_version)
  return {
    uri = envelope.uri,
    cid = envelope.cid,
    did = envelope.did,
    record = envelope.record,
    status = (state and state.status) or "unknown",
    latestVersion = latest_version,
    indexedAt = envelope.indexed_at,
  }
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
