-- at.happyproto.fleet.getGrowth
--
-- How fast the fleet and each instance are growing. Admin only.
--
-- Reads instance_daily_deltas, which DISCARDS counter resets rather than
-- clamping them to zero -- so a wiped volume contributes nothing to a growth
-- rate instead of inventing a flat period. Resets are visible separately via
-- at.happyproto.fleet.getResets.

-- @prelude gate, clickhouse

-- Matches the benchmark rollup's window, so a rate shown here and a percentile
-- shown by getBenchmarks describe the same period.
local WINDOW_DAYS = 14

local METRICS = "'records', 'users', 'spaces', 'event_logs'"

function handle(input, ctx)
  local refused = gate_admin(ctx)
  if refused then return refused end

  -- Deltas need two consecutive days per instance. With fewer there is nothing
  -- to report, and saying so beats rendering zeroes -- a zero is a claim.
  local span_rows, span_err = query(ctx, [[
    SELECT count(DISTINCT toDate(ts)) AS days FROM instance_snapshots
  ]])
  if not span_rows then return failure("Upstream", span_err) end
  local days = tonumber((span_rows[1] or {}).days) or 0
  if days < 2 then
    return { status = "accruing", have = days, need = 2, unit = "days",
             fleet = json.to_array({}), byInstance = json.to_array({}) }
  end

  local fleet_rows, fleet_err = query(ctx, string.format([[
    SELECT
      metric,
      sum(delta) / greatest(count(DISTINCT day), 1) AS per_day
    FROM instance_daily_deltas
    WHERE metric IN (%s) AND day > today() - %d
    GROUP BY metric
    ORDER BY metric
  ]], METRICS, WINDOW_DAYS))
  if not fleet_rows then return failure("Upstream", fleet_err) end

  local instance_rows, instance_err = query(ctx, string.format([[
    SELECT instance_id, metric, avg(delta) AS rate
    FROM instance_daily_deltas
    WHERE metric IN (%s) AND day > today() - %d
    GROUP BY instance_id, metric
    ORDER BY instance_id, metric
  ]], METRICS, WINDOW_DAYS))
  if not instance_rows then return failure("Upstream", instance_err) end

  local fleet = {}
  for _, r in ipairs(fleet_rows) do
    fleet[#fleet + 1] = { metric = r.metric, perDay = tonumber(r.per_day) or 0 }
  end

  local by_instance = {}
  for _, r in ipairs(instance_rows) do
    by_instance[#by_instance + 1] = {
      instanceId = r.instance_id,
      metric = r.metric,
      rate = tonumber(r.rate) or 0,
    }
  end

  return {
    status = "ok",
    windowDays = WINDOW_DAYS,
    fleet = json.to_array(fleet),
    byInstance = json.to_array(by_instance),
  }
end
