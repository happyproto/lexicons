-- at.happyproto.fleet.getBenchmarks
--
-- Where one instance sits in its size cohort. Admin only.
--
-- This script NEVER COMPUTES A COHORT PERCENTILE FROM RAW DATA. It reads rows
-- the collector's refreshable materialized view already computed, with
-- cohorting and withholding applied at rollup time. Deriving percentiles here
-- would be a second implementation of a rule that must not differ.
--
-- MIN_COHORT below must match `benchmarks::MIN_COHORT` in the collector
-- (Rust). The two runtimes share nothing, so this cannot be enforced -- only
-- cross-referenced. Below the minimum a percentile is not an aggregate; it is
-- individual data with a statistic drawn over it.
--
-- `instance` is the only caller-supplied value in this repo. It travels as a
-- ClickHouse param_instance argument paired with an {instance:String}
-- placeholder. There is no interpolation path.

-- @prelude gate, clickhouse

local MIN_COHORT = 10

function handle()
  local refused = denied()
  if refused then return refused end

  local instance = params.instance
  if not instance or instance == "" then
    return failure("InvalidRequest", "instance is required.")
  end

  -- The caller's own cohort, derived exactly as migration 0004 derives it:
  -- concat('1e', floor(log10(greatest(records, 1)))). If this expression and
  -- the rollup's ever disagree, nothing joins and every metric silently
  -- vanishes rather than erroring -- so they are kept character-for-character.
  local mine_rows, mine_err = query([[
    SELECT
      concat('1e', toString(toUInt8(floor(log10(greatest(t['records'], 1)))))) AS cohort,
      toFloat64(t['records'])        AS records,
      toFloat64(t['database_bytes']) AS database_bytes,
      toFloat64(t['event_logs'])     AS event_logs,
      toFloat64(t['rss_anon'])       AS rss_anon
    FROM (
      SELECT argMax(totals, ts) AS t
      FROM instance_snapshots
      WHERE instance_id = {instance:String}
      GROUP BY instance_id
    )
  ]], { instance = instance })
  if not mine_rows then return failure("Upstream", mine_err) end
  local mine = mine_rows[1]
  if not mine then
    return failure("NotFound", "No snapshots for that instance.")
  end

  local cohort = mine.cohort

  local cohort_rows, cohort_err = query([[
    SELECT
      metric,
      cohort_size,
      p50,
      quantiles,
      toString(computed_at) AS computed_at
    FROM fleet_benchmarks
    WHERE cohort = {cohort:String}
    ORDER BY metric
  ]], { cohort = cohort })
  if not cohort_rows then return failure("Upstream", cohort_err) end

  if #cohort_rows == 0 then
    return { status = "withheld", reason = "cohort", cohort = cohort,
             cohortSize = 0, minimum = MIN_COHORT, metrics = toarray({}) }
  end

  local cohort_size = tonumber(cohort_rows[1].cohort_size) or 0
  if cohort_size < MIN_COHORT then
    -- The correct answer, not a failure. Name the size so a reader knows how
    -- far off it is rather than being told only that something is missing.
    return { status = "withheld", reason = "cohort", cohort = cohort,
             cohortSize = cohort_size, minimum = MIN_COHORT, metrics = toarray({}) }
  end

  local values = {
    ["level:records"] = tonumber(mine.records) or 0,
    ["level:database_bytes"] = tonumber(mine.database_bytes) or 0,
    ["level:event_logs"] = tonumber(mine.event_logs) or 0,
    ["level:rss_anon"] = tonumber(mine.rss_anon) or 0,
  }

  local metrics = {}
  local computed_at = nil
  for _, r in ipairs(cohort_rows) do
    computed_at = computed_at or r.computed_at
    local value = values[r.metric]
    if value then
      -- Share of the 21 quantile points at or below the value, matching
      -- `benchmarks::percentile_of` in the collector.
      local quantiles = r.quantiles or {}
      local at_or_below = 0
      for _, q in ipairs(quantiles) do
        if (tonumber(q) or 0) <= value then at_or_below = at_or_below + 1 end
      end
      local percentile = 0
      if #quantiles > 0 then
        percentile = (at_or_below / #quantiles) * 100
      end
      metrics[#metrics + 1] = {
        metric = r.metric,
        value = value,
        p50 = tonumber(r.p50) or 0,
        percentile = percentile,
      }
    end
  end

  return {
    status = "ok",
    cohort = cohort,
    cohortSize = cohort_size,
    -- The rollup is REFRESH EVERY 1 DAY, so this can be 24 hours old. Say so
    -- rather than implying live numbers.
    computedAt = computed_at,
    metrics = toarray(metrics),
  }
end
