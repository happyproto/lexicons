-- at.happyproto.fleet.listInstances
--
-- The reporting fleet, one row per instance from its most recent snapshot,
-- plus what the fleet has consented to share. Admin only.
--
-- Consent coverage is returned alongside the rows rather than left implicit:
-- a missing `contact` is an operator's decision, not a hole in collection, and
-- a reviewer who cannot tell those apart will misread the fleet.

local SPACE_URI = env.HAPPYPROTO_ADMIN_SPACE
local CH_URL = env.HAPPYPROTO_CLICKHOUSE_URL
local CH_USER = env.HAPPYPROTO_CLICKHOUSE_USER
local CH_PASSWORD = env.HAPPYPROTO_CLICKHOUSE_PASSWORD
local CH_DB = env.HAPPYPROTO_CLICKHOUSE_DB

local function failure(name, message)
  return { error = name, message = message }
end

--- Admin gate. Identical to the one in getSignals.lua by design — these are
--- standalone files with no shared module, so the checks are kept in step by
--- hand rather than by import.
local function denied()
  if not caller_did or caller_did == "" then
    return failure("AuthRequired", "This endpoint requires an authenticated caller.")
  end
  if not SPACE_URI or SPACE_URI == "" then
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

local function query(sql)
  local absent = missing_config()
  if absent then
    return nil, absent
  end
  local response = http.post(CH_URL, {
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

local function int(v)
  return tonumber(v) or 0
end

function handle()
  local refused = denied()
  if refused then return refused end

  -- argMax(..., ts) takes each field from the newest snapshot per instance,
  -- so a row is always internally consistent rather than mixing snapshots.
  local rows, err = query([[
    SELECT
      instance_id,
      max(ts)                                          AS last_seen,
      argMax(happyview_version, ts)                    AS version,
      argMax(report_mode, ts)                          AS report_mode,
      argMax(totals['records'], ts)                    AS records,
      argMax(totals['users'], ts)                      AS users,
      argMax(totals['spaces'], ts)                     AS spaces,
      argMax(totals['lexicons'], ts)                   AS lexicons,
      argMax(totals['events.script.error'], ts)        AS script_errors
    FROM instance_snapshots
    GROUP BY instance_id
    ORDER BY last_seen DESC
  ]])
  if not rows then return failure("Upstream", err) end

  local instances = {}
  for _, r in ipairs(rows) do
    instances[#instances + 1] = {
      instanceId = r.instance_id,
      lastSeen = r.last_seen,
      version = r.version,
      reportMode = r.report_mode,
      records = int(r.records),
      users = int(r.users),
      spaces = int(r.spaces),
      lexicons = int(r.lexicons),
      scriptErrors = int(r.script_errors),
    }
  end

  local consent_rows = query([[
    SELECT
      count()                                    AS total,
      countIf(contact IS NOT NULL)               AS with_contact,
      countIf(length(lexicon_names) > 0)         AS with_lexicon_names,
      countIf(length(host) > 0)                  AS with_host
    FROM (
      SELECT
        argMax(contact, ts)       AS contact,
        argMax(lexicon_names, ts) AS lexicon_names,
        argMax(host, ts)          AS host
      FROM instance_snapshots
      GROUP BY instance_id
    )
  ]]) or {}
  local c = consent_rows[1] or {}

  return {
    instances = instances,
    consent = {
      total = int(c.total),
      withContact = int(c.with_contact),
      withLexiconNames = int(c.with_lexicon_names),
      withHost = int(c.with_host),
    },
  }
end
