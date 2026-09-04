-- at.happyproto.fleet.getLexiconShape
--
-- How many collections instances define, and how concentrated their data is.
-- Admin only.
--
-- lexicon_shares is the top collection shares, descending, so shares[1] is the
-- largest collection's share of records. A fleet where that sits near 90%
-- means one collection dominates, and per-collection cost modelling is nearly
-- single-collection modelling.
--
-- lexicon_count is always sent; lexicon_names is consent-gated and is NOT read
-- here. Shape is the tier-1 denominator, names describe a sub-population, and
-- quoting one as if it described the other is the failure mode to watch for.

-- @prelude gate, clickhouse

function handle()
  local refused = denied()
  if refused then return refused end

  local rows, err = query([[
    SELECT
      count()                                              AS total,
      countIf(length(shares) > 0)                          AS with_shares,
      quantileExact(0.5)(n)                                AS count_p50,
      quantileExact(0.9)(n)                                AS count_p90,
      quantileExactIf(0.5)(shares[1], length(shares) > 0)   AS top_share_p50,
      quantileExactIf(0.9)(shares[1], length(shares) > 0)   AS top_share_p90
    FROM (
      SELECT
        instance_id,
        argMax(lexicon_count, ts)  AS n,
        argMax(lexicon_shares, ts) AS shares
      FROM instance_snapshots
      GROUP BY instance_id
    )
  ]])
  if not rows then return failure("Upstream", err) end
  local r = rows[1] or {}
  local total = tonumber(r.total) or 0

  if total == 0 then
    return { status = "accruing", have = 0, need = 1, unit = "snapshots" }
  end

  return {
    status = "ok",
    instances = total,
    lexiconCount = {
      p50 = tonumber(r.count_p50) or 0,
      p90 = tonumber(r.count_p90) or 0,
    },
    topCollectionShare = {
      p50 = tonumber(r.top_share_p50) or 0,
      p90 = tonumber(r.top_share_p90) or 0,
    },
    coverage = { sharing = tonumber(r.with_shares) or 0, of = total },
  }
end
