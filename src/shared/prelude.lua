-- Blocks inlined into scripts by `bun run gen`. NOT deployed: this file lives
-- under src/shared/, and only src/at/** mirrors into lua/.
--
-- Blocks are emitted in the order they appear HERE, not the order a script
-- lists them, because Lua requires a local to be declared before any function
-- closing over it. `gate` implies `failure`; `clickhouse` and `provisioner`
-- imply `json` and `failure`; `instance` implies `json`.
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

-- @block gate
local spaces = require("happyview.spaces")

--- nil when the caller may proceed, else a failure table. Fails closed: a
--- missing caller, a missing or empty space variable, a space that cannot be
--- read, and no access all refuse.
---
--- The space uri is a script variable, not a literal, because it embeds the
--- authority DID, and the whole uri is what makes the check mean anything:
--- matching on the space TYPE would admit everyone, since any user can create
--- a space of any type and is auto-added to their own as a member.
local function gate_member(ctx, var, who)
  if not ctx.caller_did or ctx.caller_did == "" then
    return failure("AuthRequired", "This endpoint requires an authenticated caller.")
  end
  local uri = (ctx.env or {})[var]
  if not uri or uri == "" then
    -- Fail closed: with no space configured, nobody is a member.
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
  if not access or access == "none" then
    return failure("Forbidden", (who:gsub("^%l", string.upper)) .. "s only.")
  end
  return nil
end

--- Staff: membership of HAPPYPROTO_ADMIN_SPACE.
local function gate_admin(ctx)
  return gate_member(ctx, "HAPPYPROTO_ADMIN_SPACE", "admin")
end

--- Customers: membership of HAPPYPROTO_CUSTOMERS_SPACE.
local function gate_customer(ctx)
  return gate_member(ctx, "HAPPYPROTO_CUSTOMERS_SPACE", "customer")
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

--- Percent-encode a parameter value for the ClickHouse query string.
local function url_encode(s)
  return (tostring(s):gsub("[^%w%-%_%.%~]", function(c)
    return string.format("%%%02X", string.byte(c))
  end))
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

--- A provisioner reply mapped to a failure table.
---
--- A known code passes through with its message at any error status:
--- NoCapacity arrives as a 503, and it means the same thing as the 4xx codes.
--- Everything else -- an unknown code, a 500, a body that is not the
--- provisioner's error shape, no reply at all (status nil, `decoded` the
--- transport message) -- is Upstream with a fixed message. The raw body is
--- logged and never returned: it can carry internal detail.
local function provisioner_failure(status, decoded)
  if type(status) == "number" and status >= 400 and type(decoded) == "table"
    and PASSTHROUGH[decoded.error] then
    local message = decoded.message
    if type(message) ~= "string" or message == "" then
      message = "The provisioner refused the request."
    end
    return failure(decoded.error, message)
  end
  log.warn("provisioner request failed", { status = status, body = decoded })
  return failure("Upstream", "The provisioner could not complete the request.")
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
