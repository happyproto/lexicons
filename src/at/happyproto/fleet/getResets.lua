-- at.happyproto.fleet.getResets
--
-- Counter resets across the fleet. Admin only.
--
-- instance_daily_deltas discards negative deltas, which is right for growth
-- analysis and wrong for operations: a reset is a restored backup, a wiped
-- volume, a re-provision or a wrong clock, and every one of those is worth
-- seeing. instance_daily_resets (collector migration 0005) is its exact
-- complement.
--
-- Both values are carried. "records fell" is not actionable; "records fell
-- from 412,000 to 12" identifies a wiped volume on sight.

-- @prelude gate, clickhouse

local WINDOW_DAYS = 90
local LIMIT = 200

function handle(input, ctx)
  local refused = gate_admin(ctx)
  if refused then return refused end

  -- A reset needs a predecessor. With one day of history "no resets" would be
  -- a claim we cannot support, which is a different statement from "none".
  local span_rows, span_err = query(ctx, [[
    SELECT count(DISTINCT toDate(ts)) AS days FROM instance_snapshots
  ]])
  if not span_rows then return failure("Upstream", span_err) end
  local days = tonumber((span_rows[1] or {}).days) or 0
  if days < 2 then
    return { status = "accruing", have = days, need = 2, unit = "days", resets = json.to_array({}) }
  end

  local rows, err = query(ctx, string.format([[
    SELECT instance_id, toString(day) AS day_text, metric, from_value, to_value
    FROM instance_daily_resets
    -- day_text, not `day`: aliasing toString(day) back to `day` shadows the
    -- Date column, and ClickHouse then resolves `day` in this WHERE to the
    -- String alias -- "no supertype for types String, Date". Caught against
    -- ClickHouse 26.8 rather than on the live instance.
    WHERE day > today() - %d
    ORDER BY day DESC, instance_id
    LIMIT %d
  ]], WINDOW_DAYS, LIMIT))
  if not rows then return failure("Upstream", err) end

  local resets = {}
  for _, r in ipairs(rows) do
    resets[#resets + 1] = {
      instanceId = r.instance_id,
      day = r.day_text,
      metric = r.metric,
      from = tonumber(r.from_value) or 0,
      to = tonumber(r.to_value) or 0,
    }
  end

  return { status = "ok", windowDays = WINDOW_DAYS, resets = json.to_array(resets) }
end
