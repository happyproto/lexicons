-- at.happyproto.fleet.getVersions
--
-- Which HappyView builds the fleet is running, and how long it takes to move
-- after a release. Admin only.
--
-- medianDaysToAdopt is measured from the version's FIRST appearance anywhere
-- in the fleet, not from its release date, which is not collected. Instances
-- that never adopted are excluded rather than counted as infinite -- an
-- instance still on an old build has not "taken forever", it has not moved.

-- @prelude gate, clickhouse

function handle(input, ctx)
  local refused = gate_admin(ctx)
  if refused then return refused end

  local rows, err = query(ctx, [[
    WITH
    current AS (
      SELECT instance_id, argMax(happyview_version, ts) AS version
      FROM instance_snapshots
      GROUP BY instance_id
    ),
    fleet_first AS (
      SELECT happyview_version AS version, min(ts) AS fleet_first_seen
      FROM instance_snapshots
      GROUP BY happyview_version
    ),
    instance_first AS (
      SELECT happyview_version AS version, instance_id, min(ts) AS adopted_at
      FROM instance_snapshots
      GROUP BY happyview_version, instance_id
    ),
    lag AS (
      SELECT
        i.version AS version,
        count() AS adopters,
        quantileExact(0.5)(dateDiff('day', f.fleet_first_seen, i.adopted_at)) AS median_days
      FROM instance_first AS i
      INNER JOIN fleet_first AS f ON i.version = f.version
      GROUP BY i.version
    )
    SELECT
      c.version                          AS version,
      count()                            AS instances,
      toString(any(f.fleet_first_seen))  AS first_seen,
      any(l.median_days)                 AS median_days,
      any(l.adopters)                    AS adopters
    FROM current AS c
    LEFT JOIN fleet_first AS f ON c.version = f.version
    LEFT JOIN lag AS l ON c.version = l.version
    GROUP BY c.version
    ORDER BY instances DESC, version
  ]])
  if not rows then return failure("Upstream", err) end

  local versions = {}
  for _, r in ipairs(rows) do
    versions[#versions + 1] = {
      version = r.version,
      instances = tonumber(r.instances) or 0,
      firstSeen = r.first_seen,
      medianDaysToAdopt = tonumber(r.median_days) or 0,
      adopters = tonumber(r.adopters) or 0,
    }
  end

  -- Upgrade lag needs at least one observed transition. One version across the
  -- whole fleet means nothing has moved yet, which is not the same as moving
  -- slowly. The version list itself is still returned and still true.
  if #versions < 2 then
    return { status = "accruing", have = #versions, need = 2, unit = "days",
             versions = json.to_array(versions) }
  end
  return { status = "ok", versions = json.to_array(versions) }
end
