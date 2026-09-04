-- at.happyproto.fleet.getCostShape
--
-- What an instance costs to run. Admin only.
--
-- THE COST METRICS LIVE IN `host`, NOT `totals`. This endpoint originally read
-- totals['database_bytes'] and totals['rss_anon'] -- the names the collector's
-- own benchmark rollup uses -- and silently reported zeros, because the fleet
-- actually sends host['db_bytes'] and host['memory_anon_bytes'].
--
-- Both are read, host first, so this is correct whichever map a given build
-- populates. `sources` reports which one each figure came from, because a
-- disagreement between two maps is exactly the kind of thing that should be
-- visible rather than silently resolved. If a figure reads 0 with source
-- "none", the key is absent from both -- which is a fact worth seeing, not a
-- zero worth believing.
--
-- MEMORY IS NEVER TOTALLED. Anonymous and file-backed memory are reported as
-- separate figures. Aggregate RSS is dominated by page cache, and reading it
-- as one number is how a healthy instance gets diagnosed as leaking. The fleet
-- sends both halves; summing them here would throw that away.

-- @prelude gate, clickhouse

local WINDOW_DAYS = 14

function handle()
  local refused = denied()
  if refused then return refused end

  -- toFloat64OrZero, not toFloat64: `host` is Map(String, String) and a
  -- missing key yields '', which toFloat64 rejects outright.
  local rows, err = query(string.format([[
    WITH latest AS (
      SELECT
        instance_id,
        argMax(totals, ts) AS t,
        argMax(host, ts)   AS h
      FROM instance_snapshots
      WHERE ts > now() - INTERVAL %d DAY
      GROUP BY instance_id
    ),
    resolved AS (
      SELECT
        instance_id,
        toFloat64(t['records']) AS records,
        if(h['db_bytes'] != '',
           toFloat64OrZero(h['db_bytes']),
           toFloat64(t['database_bytes']))          AS disk_bytes,
        if(h['memory_anon_bytes'] != '',
           toFloat64OrZero(h['memory_anon_bytes']),
           toFloat64(t['rss_anon']))                AS memory_anon,
        toFloat64OrZero(h['memory_file_bytes'])     AS memory_file,
        h['db_bytes'] != ''            AS disk_from_host,
        t['database_bytes'] > 0        AS disk_from_totals,
        h['memory_anon_bytes'] != ''   AS anon_from_host,
        t['rss_anon'] > 0              AS anon_from_totals,
        h['memory_file_bytes'] != ''   AS file_present
      FROM latest
    )
    SELECT
      count()                                                       AS instances,
      countIf(records > 0)                                          AS bpr_instances,
      quantileExactIf(0.5)(disk_bytes / records, records > 0)        AS bpr_p50,
      quantileExactIf(0.9)(disk_bytes / records, records > 0)        AS bpr_p90,
      quantileExactIf(0.5)(disk_bytes, disk_bytes > 0)               AS disk_p50,
      quantileExactIf(0.9)(disk_bytes, disk_bytes > 0)               AS disk_p90,
      countIf(disk_bytes > 0)                                        AS disk_instances,
      quantileExactIf(0.5)(memory_anon, memory_anon > 0)             AS anon_p50,
      quantileExactIf(0.9)(memory_anon, memory_anon > 0)             AS anon_p90,
      countIf(memory_anon > 0)                                       AS anon_instances,
      quantileExactIf(0.5)(memory_file, memory_file > 0)             AS file_p50,
      quantileExactIf(0.9)(memory_file, memory_file > 0)             AS file_p90,
      countIf(memory_file > 0)                                       AS file_instances,
      max(disk_from_host)                                            AS any_disk_host,
      max(disk_from_totals)                                          AS any_disk_totals,
      max(anon_from_host)                                            AS any_anon_host,
      max(anon_from_totals)                                          AS any_anon_totals,
      max(file_present)                                              AS any_file
    FROM resolved
  ]], WINDOW_DAYS))
  if not rows then return failure("Upstream", err) end
  local r = rows[1] or {}
  local instances = tonumber(r.instances) or 0

  if instances == 0 then
    return { status = "accruing", have = 0, need = 1, unit = "snapshots" }
  end

  local function source(host_flag, totals_flag)
    if tonumber(host_flag) == 1 then return "host" end
    if tonumber(totals_flag) == 1 then return "totals" end
    return "none"
  end

  local function pair(p50, p90, n)
    return {
      p50 = tonumber(p50) or 0,
      p90 = tonumber(p90) or 0,
      instances = tonumber(n) or 0,
    }
  end

  return {
    status = "ok",
    instances = instances,
    windowDays = WINDOW_DAYS,
    bytesPerRecord = pair(r.bpr_p50, r.bpr_p90, r.bpr_instances),
    diskBytes = pair(r.disk_p50, r.disk_p90, r.disk_instances),
    memoryAnon = pair(r.anon_p50, r.anon_p90, r.anon_instances),
    -- Its own figure, never added to memoryAnon.
    memoryFile = pair(r.file_p50, r.file_p90, r.file_instances),
    sources = {
      diskBytes = source(r.any_disk_host, r.any_disk_totals),
      memoryAnon = source(r.any_anon_host, r.any_anon_totals),
      memoryFile = source(r.any_file, 0),
    },
  }
end
