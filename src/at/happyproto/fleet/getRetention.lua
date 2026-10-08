-- at.happyproto.fleet.getRetention
--
-- Survival by first-seen cohort. Admin only.
--
-- MANUAL-MODE INSTANCES ARE EXCLUDED. A manual instance quiet for 90 days is
-- quiet, not dead -- it has no reporting cadence to miss. Counting manual
-- silence as churn would bias this curve pessimistically and invisibly, which
-- is the single easiest way to make this number lie.
--
-- The denominator is ELIGIBILITY, not cohort size. An instance first seen ten
-- days ago cannot have survived thirty, and counting it as a failure would
-- drag every recent cohort toward zero.

-- @prelude gate, clickhouse

function handle(input, ctx)
  local refused = gate_admin(ctx)
  if refused then return refused end

  local rows, err = query(ctx, [[
    WITH lifespans AS (
      SELECT
        instance_id,
        min(ts)                 AS first_seen,
        max(ts)                 AS last_seen,
        argMax(report_mode, ts) AS mode
      FROM instance_snapshots
      GROUP BY instance_id
    )
    SELECT
      toString(toStartOfMonth(first_seen))                  AS cohort,
      count()                                               AS started,
      countIf(dateDiff('day', first_seen, last_seen) >= 30)  AS survived_30,
      countIf(dateDiff('day', first_seen, last_seen) >= 60)  AS survived_60,
      countIf(dateDiff('day', first_seen, last_seen) >= 90)  AS survived_90,
      countIf(dateDiff('day', first_seen, now()) >= 30)      AS eligible_30,
      countIf(dateDiff('day', first_seen, now()) >= 60)      AS eligible_60,
      countIf(dateDiff('day', first_seen, now()) >= 90)      AS eligible_90
    FROM lifespans
    WHERE mode != 'manual'
    GROUP BY cohort
    ORDER BY cohort
  ]])
  if not rows then return failure("Upstream", err) end

  local cohorts = {}
  local any_eligible = false
  for _, r in ipairs(rows) do
    local e30 = tonumber(r.eligible_30) or 0
    if e30 > 0 then any_eligible = true end
    cohorts[#cohorts + 1] = {
      cohort = r.cohort,
      started = tonumber(r.started) or 0,
      survived30 = tonumber(r.survived_30) or 0,
      survived60 = tonumber(r.survived_60) or 0,
      survived90 = tonumber(r.survived_90) or 0,
      eligible30 = e30,
      eligible60 = tonumber(r.eligible_60) or 0,
      eligible90 = tonumber(r.eligible_90) or 0,
    }
  end

  -- Nothing is eligible until some instance has been reporting for 30 days.
  -- Publishing a 0% survival curve before then would be false, not empty.
  if not any_eligible then
    return { status = "accruing", have = 0, need = 30, unit = "days", cohorts = json.to_array(cohorts) }
  end
  return { status = "ok", cohorts = json.to_array(cohorts) }
end
