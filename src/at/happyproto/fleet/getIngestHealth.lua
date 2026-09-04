-- at.happyproto.fleet.getIngestHealth
--
-- Whether the telemetry itself can be trusted. Admin only.
--
-- Report lag and clock skew are DIFFERENT FACTS and must not be averaged
-- together. Lag is received_at - ts and is ordinary. Skew is ts > received_at:
-- a snapshot stamped in the future, which means a wrong clock on the instance
-- and makes every delta computed from it suspect. Folding skew into a lag
-- average would produce a SMALLER mean and hide the problem entirely.

-- @prelude gate, clickhouse

local WINDOW_DAYS = 14

function handle()
  local refused = denied()
  if refused then return refused end

  local lag_rows, lag_err = query(string.format([[
    SELECT
      count()                                                 AS snapshots,
      quantileExact(0.5)(dateDiff('second', ts, received_at))  AS p50,
      quantileExact(0.9)(dateDiff('second', ts, received_at))  AS p90,
      max(dateDiff('second', ts, received_at))                 AS worst
    FROM instance_snapshots
    WHERE ts > now() - INTERVAL %d DAY AND ts <= received_at
  ]], WINDOW_DAYS))
  if not lag_rows then return failure("Upstream", lag_err) end
  local lag = lag_rows[1] or {}

  if (tonumber(lag.snapshots) or 0) == 0 then
    return { status = "accruing", have = 0, need = 1, unit = "snapshots" }
  end

  local skew_rows, skew_err = query(string.format([[
    SELECT instance_id, max(dateDiff('second', received_at, ts)) AS ahead
    FROM instance_snapshots
    WHERE ts > now() - INTERVAL %d DAY AND ts > received_at
    GROUP BY instance_id
    ORDER BY ahead DESC
  ]], WINDOW_DAYS))
  if not skew_rows then return failure("Upstream", skew_err) end

  local schema_rows, schema_err = query([[
    SELECT schema_version, count() AS instances
    FROM (
      SELECT instance_id, argMax(schema_version, ts) AS schema_version
      FROM instance_snapshots
      GROUP BY instance_id
    )
    GROUP BY schema_version
    ORDER BY schema_version
  ]])
  if not schema_rows then return failure("Upstream", schema_err) end

  local skewed = {}
  for _, r in ipairs(skew_rows) do
    skewed[#skewed + 1] = {
      instanceId = r.instance_id,
      aheadSeconds = tonumber(r.ahead) or 0,
    }
  end

  local schema_versions = {}
  for _, r in ipairs(schema_rows) do
    schema_versions[#schema_versions + 1] = {
      version = tonumber(r.schema_version) or 0,
      instances = tonumber(r.instances) or 0,
    }
  end

  return {
    status = "ok",
    windowDays = WINDOW_DAYS,
    lag = {
      p50 = tonumber(lag.p50) or 0,
      p90 = tonumber(lag.p90) or 0,
      max = tonumber(lag.worst) or 0,
    },
    skewed = toarray(skewed),
    schemaVersions = toarray(schema_versions),
  }
end
