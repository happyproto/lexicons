-- at.happyproto.fleet.getHostMix
--
-- What the fleet runs on. Admin only.
--
-- `host` is NOT a bag of categorical facts. It carries three different kinds
-- of thing side by side:
--
--   categorical  containerised=true, cpu_cores=8      -- a real "mix"
--   measured     db_bytes=60767098547, net_rx_bytes   -- unique per instance
--   documents    vacuum={"attempt_started_at":...}    -- embedded JSON
--
-- Enumerating every distinct value, which this endpoint used to do, turns the
-- last two into an unreadable wall: one row per instance for a metric nobody
-- can compare that way, and raw JSON blobs rendered as if they were values.
--
-- So keys are CLASSIFIED by cardinality and shape, and only categorical ones
-- get a value distribution. The rest are named with their distinct count, so a
-- reader can see the key exists without being shown eight thousand characters
-- of it. Measurements belong in getCostShape, where they can be summarised.
--
-- `host` is also consent-gated: an operator who declined sends nothing, and
-- the column is an empty map. Coverage is returned alongside, because a count
-- over twelve of thirty instances is a different claim from a count over
-- thirty, and a reader who cannot tell them apart reads a refusal as a
-- finding.

-- @prelude gate, clickhouse

-- A category is something whose values REPEAT. An absolute threshold cannot
-- express that: in a fleet of seven, every key has at most seven distinct
-- values, so db_bytes and net_rx_bytes both look "low cardinality" and get
-- enumerated one row per instance -- exactly the wall this endpoint had.
--
-- The test is therefore relative: each value must be shared by at least two
-- instances on average. MAX_DISTINCT is a second, absolute ceiling so a large
-- fleet cannot produce a forty-row "distribution" that passes the ratio.
local MIN_INSTANCES_PER_VALUE = 2
local MAX_DISTINCT = 8

-- Longer than this is a document, not a value.
local MAX_VALUE_LEN = 48

function handle(input, ctx)
  local refused = gate_admin(ctx)
  if refused then return refused end

  local coverage_rows, coverage_err = query(ctx, [[
    SELECT
      count()                 AS total,
      countIf(length(h) > 0)  AS sharing
    FROM (
      SELECT instance_id, argMax(host, ts) AS h
      FROM instance_snapshots
      GROUP BY instance_id
    )
  ]])
  if not coverage_rows then return failure("Upstream", coverage_err) end
  local cov = coverage_rows[1] or {}
  local sharing = tonumber(cov.sharing) or 0
  local total = tonumber(cov.total) or 0

  -- Nobody consented. A complete, true answer -- not an absence and not an
  -- error.
  if sharing == 0 then
    return {
      status = "ok",
      coverage = { sharing = 0, of = total },
      facts = json.to_array({}),
      varying = json.to_array({}),
    }
  end

  -- One classification, two projections. Computing it once means the "facts"
  -- and "varying" lists cannot disagree about which keys are categorical.
  local classified = string.format([[
    WITH
    latest AS (
      SELECT instance_id, argMax(host, ts) AS h
      FROM instance_snapshots
      GROUP BY instance_id
    ),
    pairs AS (
      SELECT instance_id, key, value
      FROM latest
      ARRAY JOIN mapKeys(h) AS key, mapValues(h) AS value
    ),
    shape AS (
      SELECT
        key,
        uniqExact(value)                            AS distinct_values,
        count()                                     AS reporting,
        max(length(value))                          AS longest,
        max(value LIKE '{%%' OR value LIKE '[%%')   AS has_document
      FROM pairs
      GROUP BY key
    ),
    classified AS (
      SELECT
        key,
        distinct_values,
        reporting,
        (
          distinct_values * %d <= reporting
          AND distinct_values <= %d
          AND longest <= %d
          AND has_document = 0
        ) AS categorical
      FROM shape
    )
  ]], MIN_INSTANCES_PER_VALUE, MAX_DISTINCT, MAX_VALUE_LEN)

  local fact_rows, fact_err = query(ctx, classified .. [[
    SELECT p.key AS key, p.value AS value, count() AS instances
    FROM pairs AS p
    INNER JOIN classified AS c ON p.key = c.key
    WHERE c.categorical
    GROUP BY p.key, p.value
    ORDER BY p.key, instances DESC, p.value
  ]])
  if not fact_rows then return failure("Upstream", fact_err) end

  local varying_rows, varying_err = query(ctx, classified .. [[
    SELECT key, distinct_values
    FROM classified
    WHERE NOT categorical
    ORDER BY key
  ]])
  if not varying_rows then return failure("Upstream", varying_err) end

  local facts = {}
  for _, r in ipairs(fact_rows) do
    facts[#facts + 1] = {
      key = r.key,
      value = r.value,
      instances = tonumber(r.instances) or 0,
    }
  end

  local varying = {}
  for _, r in ipairs(varying_rows) do
    varying[#varying + 1] = {
      key = r.key,
      distinctValues = tonumber(r.distinct_values) or 0,
    }
  end

  return {
    status = "ok",
    coverage = { sharing = sharing, of = total },
    facts = json.to_array(facts),
    varying = json.to_array(varying),
  }
end
