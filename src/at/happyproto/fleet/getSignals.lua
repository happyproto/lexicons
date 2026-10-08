-- at.happyproto.fleet.getSignals
--
-- What is going wrong across the reporting fleet, from each instance's most
-- recent snapshot. Admin only.
--
-- Every counter in `totals` is a monotonic lifetime total, so "reported at
-- least once" is `> 0` — not a delta. With one snapshot per instance there is
-- no delta to take anyway, and this endpoint is deliberately built to work at
-- that stage rather than waiting for a time series to accumulate.

-- @prelude gate, clickhouse

-- An instance is "quiet" once its newest snapshot is this old. Auto-reporters
-- send daily, so two days is a missed report rather than ordinary jitter.
local QUIET_HOURS = 48

-- The churn threshold. A MANUAL instance is never dormant, whatever its age:
-- manual mode has no reporting cadence to miss, so counting its silence as
-- churn would bias the fleet's health pessimistically and invisibly.
local DORMANT_HOURS = 2160

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

function handle(input, ctx)
  local refused = gate_admin(ctx)
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

  local rows, err = query(ctx, sql)
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

  local quiet_rows = query(ctx, string.format([[
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

  -- Instance counts by RECENCY, not by ever-having-reported.
  --
  -- This previously came from `count()` in the signals subquery above, which
  -- counts every instance that ever sent a snapshot. A fleet where twenty of
  -- thirty died six months ago rendered as "30 instances reporting", and the
  -- calm state claimed nothing was failing across a fleet largely not there.
  --
  -- The two integer constants below are file-locals, never caller input.
  local counts_rows, counts_err = query(ctx, string.format([[
    SELECT
      countIf(age <= %d)                                   AS active,
      countIf(age > %d AND (age <= %d OR mode = 'manual')) AS quiet,
      countIf(age > %d AND mode != 'manual')               AS dormant,
      count()                                              AS total
    FROM (
      SELECT
        instance_id,
        dateDiff('hour', max(ts), now()) AS age,
        argMax(report_mode, ts)          AS mode
      FROM instance_snapshots
      GROUP BY instance_id
    )
  ]], QUIET_HOURS, QUIET_HOURS, DORMANT_HOURS, DORMANT_HOURS))
  if not counts_rows then return failure("Upstream", counts_err) end
  local c = counts_rows[1] or {}

  return {
    instances = {
      active = tonumber(c.active) or 0,
      quiet = tonumber(c.quiet) or 0,
      dormant = tonumber(c.dormant) or 0,
      total = tonumber(c.total) or 0,
    },
    signals = json.to_array(signals),
    quiet = json.to_array(quiet),
  }
end
