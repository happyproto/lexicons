-- at.happyproto.fleet.getSignals
--
-- What is going wrong across the reporting fleet, from each instance's most
-- recent snapshot. Admin only.
--
-- Every counter in `totals` is a monotonic lifetime total, so "reported at
-- least once" is `> 0` — not a delta. With one snapshot per instance there is
-- no delta to take anyway, and this endpoint is deliberately built to work at
-- that stage rather than waiting for a time series to accumulate.

local SPACE_URI = env.HAPPYPROTO_ADMIN_SPACE
local CH_URL = env.HAPPYPROTO_CLICKHOUSE_URL
local CH_USER = env.HAPPYPROTO_CLICKHOUSE_USER
local CH_PASSWORD = env.HAPPYPROTO_CLICKHOUSE_PASSWORD
local CH_DB = env.HAPPYPROTO_CLICKHOUSE_DB

-- An instance is "quiet" once its newest snapshot is this old. Auto-reporters
-- send daily, so two days is a missed report rather than ordinary jitter.
local QUIET_HOURS = 48

-- key -> label and severity. Adding a row here adds a signal; the SQL is
-- generated from it so the two cannot disagree.
local SIGNALS = {
  { key = "events.script.error",          label = "reporting script errors",   severity = "warn" },
  { key = "events.script.dead_lettered",  label = "dead-lettered a script",    severity = "warn" },
  { key = "events.record.cid_mismatch",   label = "record CID mismatch",       severity = "warn" },
  { key = "events.job.failed",            label = "job failures",              severity = "warn" },
  { key = "events.backfill.retry_started",label = "backfill retries",          severity = "info" },
  { key = "events.jetstream.disconnected",label = "saw Jetstream disconnect",  severity = "info" },
}

local function failure(name, message)
  return { error = name, message = message }
end

--- Admin gate. Repeated in each fleet script because Lua scripts here are
--- standalone files with no shared module; keep the three checks identical.
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

--- Run SQL against ClickHouse and return its `data` rows.
--- Credentials travel as headers, never in the URL, so they stay out of any
--- proxy or access log that records query strings.
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

function handle()
  local refused = denied()
  if refused then return refused end

  -- Build the countIf list from SIGNALS. The keys are literals from this file,
  -- never caller input, so there is nothing here for a caller to inject into.
  local counts = {}
  for i, s in ipairs(SIGNALS) do
    counts[#counts + 1] = string.format(
      "countIf(t['%s'] > 0) AS n%d, sum(t['%s']) AS s%d", s.key, i, s.key, i)
  end

  local sql = [[
    SELECT ]] .. table.concat(counts, ", ") .. [[, count() AS instances
    FROM (
      SELECT instance_id, argMax(totals, ts) AS t
      FROM instance_snapshots
      GROUP BY instance_id
    )
  ]]

  local rows, err = query(sql)
  if not rows then return failure("Upstream", err) end
  local row = rows[1] or {}

  local signals = {}
  for i, s in ipairs(SIGNALS) do
    local n = tonumber(row["n" .. i]) or 0
    if n > 0 then
      signals[#signals + 1] = {
        key = s.key,
        label = s.label,
        instances = n,
        total = tonumber(row["s" .. i]) or 0,
        severity = s.severity,
      }
    end
  end

  local quiet_rows = query(string.format([[
    SELECT instance_id, max(ts) AS last_seen
    FROM instance_snapshots
    GROUP BY instance_id
    HAVING last_seen < now() - INTERVAL %d HOUR
    ORDER BY last_seen ASC
  ]], QUIET_HOURS)) or {}

  local quiet = {}
  for _, r in ipairs(quiet_rows) do
    quiet[#quiet + 1] = { instanceId = r.instance_id, lastSeen = r.last_seen }
  end

  return {
    instances = tonumber(row.instances) or 0,
    signals = signals,
    quiet = quiet,
  }
end
