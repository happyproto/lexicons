-- Blocks inlined into scripts by `bun run gen`. NOT deployed: this file lives
-- under src/shared/, and only src/at/** mirrors into lua/.
--
-- Blocks are emitted in the order they appear HERE, not the order a script
-- lists them, because Lua requires a local to be declared before any function
-- closing over it. `gate` implies `space` and `failure`; `clickhouse` implies
-- `config` and `urlencode`, for the same reason.
--
-- `gate` is deliberately separable from `space`/`failure`: actor.getProfile
-- needs the space uri and the failure helper but must NOT be admin-gated. It
-- is the endpoint that tells a caller whether they are a member, so gating it
-- on membership would be circular.
--
-- These bodies were three hand-maintained copies before this file existed.
-- That was not sloppiness -- the sandbox has no `require` -- but denied() is
-- an admin gate on customer telemetry, and thirteen hand-kept copies is a
-- plausible auth bypass rather than a smell.

-- @block space
local SPACE_URI = env.HAPPYPROTO_ADMIN_SPACE
-- @endblock

-- @block failure
-- Expected conditions are returned, never raised. Lua's `error()` produces a
-- 500 with a stack traceback -- the wrong status for "you are not signed in",
-- and it puts internal file paths in front of the caller.
local function failure(name, message)
  return { error = name, message = message }
end
-- @endblock

-- @block gate
--- Admin gate. Every script carries an identical copy, generated from
--- src/shared/prelude.lua so the copies cannot drift.
local function denied()
  if not caller_did or caller_did == "" then
    return failure("AuthRequired", "This endpoint requires an authenticated caller.")
  end
  if not SPACE_URI or SPACE_URI == "" then
    -- Fail closed: with no admin space configured, nobody is an admin.
    return failure("Forbidden", "No admin space is configured.")
  end
  -- pcall: every atproto.spaces function RAISES if the spaces feature flag is
  -- off, and a raise inside the admin gate is a 500 that locks everyone out of
  -- the dashboard. Fail closed and legibly instead.
  local ok, access = pcall(atproto.spaces.get_access, SPACE_URI, caller_did)
  if not ok then
    return failure("Forbidden", "Admin space is unavailable.")
  end
  if not access then
    return failure("Forbidden", "Admins only.")
  end
  return nil
end
-- @endblock

-- @block config
local CH_URL = env.HAPPYPROTO_CLICKHOUSE_URL
local CH_USER = env.HAPPYPROTO_CLICKHOUSE_USER
local CH_PASSWORD = env.HAPPYPROTO_CLICKHOUSE_PASSWORD
local CH_DB = env.HAPPYPROTO_CLICKHOUSE_DB

-- Lua drops nil values from table constructors, so an unset script variable
-- would silently omit its header and ClickHouse would answer 403
-- "Authentication failed" -- indistinguishable from a wrong password.
-- Name the absent variable instead of guessing later.
local function missing_config()
  local required = {
    { "HAPPYPROTO_CLICKHOUSE_URL", CH_URL },
    { "HAPPYPROTO_CLICKHOUSE_USER", CH_USER },
    { "HAPPYPROTO_CLICKHOUSE_PASSWORD", CH_PASSWORD },
    { "HAPPYPROTO_CLICKHOUSE_DB", CH_DB },
  }
  local absent = {}
  for _, entry in ipairs(required) do
    if entry[2] == nil or entry[2] == "" then
      absent[#absent + 1] = entry[1]
    end
  end
  if #absent > 0 then
    return "missing script variable(s): " .. table.concat(absent, ", ")
  end
  return nil
end
-- @endblock

-- @block urlencode
--- Percent-encode a parameter value for the ClickHouse query string.
--- Used by query() when a script passes params.
local function url_encode(s)
  return (tostring(s):gsub("[^%w%-%_%.%~]", function(c)
    return string.format("%%%02X", string.byte(c))
  end))
end
-- @endblock

-- @block clickhouse
--- Run SQL against ClickHouse and return its `data` rows.
--- Credentials travel as headers, never in the URL, so they stay out of any
--- proxy or access log that records query strings.
---
--- Caller values travel as ClickHouse `param_<name>` arguments paired with
--- `{name:Type}` placeholders in the SQL. Interpolating them into the query
--- text would be an injection; there is no second way to pass a value.
local function query(sql, params)
  local absent = missing_config()
  if absent then
    return nil, absent
  end
  local url = CH_URL
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
  local response = http.post(url, {
    headers = {
      ["x-clickhouse-user"] = CH_USER,
      ["x-clickhouse-key"] = CH_PASSWORD,
      ["x-clickhouse-database"] = CH_DB,
    },
    body = sql .. "\nFORMAT JSON",
  })
  if response.status ~= 200 then
    -- Carry the upstream body into the error. ClickHouse explains itself
    -- ("Code: 516 ... Authentication failed", "Code: 497 ... Not enough
    -- privileges"), and discarding that turns a one-line diagnosis into
    -- guesswork. Truncated because an upstream can be verbose.
    local detail = tostring(response.body or ""):gsub("%s+", " "):sub(1, 300)
    return nil, "telemetry store answered " .. tostring(response.status)
      .. (detail ~= "" and (": " .. detail) or "")
  end
  local ok, parsed = pcall(json.decode, response.body)
  if not ok or type(parsed) ~= "table" or type(parsed.data) ~= "table" then
    return nil, "telemetry store returned an unreadable response"
  end
  return parsed.data
end
-- @endblock
