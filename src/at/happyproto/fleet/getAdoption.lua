-- at.happyproto.fleet.getAdoption
--
-- Which subsystems are load-bearing and which were built and never used.
-- Admin only.
--
-- Feature keys are enumerated from the data, not hardcoded: the collector
-- accepts unknown keys by design, so an instance running a newer build reports
-- subsystems this script has never heard of. A hardcoded list would silently
-- omit exactly the new feature someone wants to know about.
--
-- builtNotUsed -- ever-used but not active now -- is the finding being paid
-- for. Cutting that list is the cheapest scope decision available.

-- @prelude gate, clickhouse

function handle(input, ctx)
  local refused = gate_admin(ctx)
  if refused then return refused end

  local total_rows, total_err = query(ctx, [[
    SELECT count(DISTINCT instance_id) AS instances FROM instance_snapshots
  ]])
  if not total_rows then return failure("Upstream", total_err) end
  local instances = tonumber((total_rows[1] or {}).instances) or 0
  if instances == 0 then
    return { status = "accruing", have = 0, need = 1, unit = "snapshots",
             instances = 0, features = json.to_array({}) }
  end

  local rows, err = query(ctx, [[
    WITH latest AS (
      SELECT
        instance_id,
        argMax(features_ever, ts)   AS ever,
        argMax(features_active, ts) AS active
      FROM instance_snapshots
      GROUP BY instance_id
    )
    SELECT
      feature,
      countIf(ever[feature] = 1)                         AS ever_used,
      countIf(active[feature] = 1)                       AS active_now,
      countIf(ever[feature] = 1 AND active[feature] = 0)  AS built_not_used
    FROM latest
    ARRAY JOIN arrayDistinct(arrayConcat(mapKeys(ever), mapKeys(active))) AS feature
    GROUP BY feature
    ORDER BY built_not_used DESC, ever_used DESC, feature
  ]])
  if not rows then return failure("Upstream", err) end

  local features = {}
  for _, r in ipairs(rows) do
    features[#features + 1] = {
      feature = r.feature,
      everUsed = tonumber(r.ever_used) or 0,
      activeNow = tonumber(r.active_now) or 0,
      builtNotUsed = tonumber(r.built_not_used) or 0,
    }
  end

  return { status = "ok", instances = instances, features = json.to_array(features) }
end
