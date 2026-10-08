-- at.happyproto.fleet.listInstances
--
-- The reporting fleet, one row per instance from its most recent snapshot,
-- plus what the fleet has consented to share. Admin only.
--
-- Consent coverage is returned alongside the rows rather than left implicit:
-- a missing `contact` is an operator's decision, not a hole in collection, and
-- a reviewer who cannot tell those apart will misread the fleet.

-- @prelude gate, clickhouse

local function int(v)
  return tonumber(v) or 0
end

function handle(input, ctx)
  local refused = gate_admin(ctx)
  if refused then return refused end

  -- argMax(..., ts) takes each field from the newest snapshot per instance,
  -- so a row is always internally consistent rather than mixing snapshots.
  local rows, err = query(ctx, [[
    SELECT
      instance_id,
      max(ts)                                          AS last_seen,
      argMax(happyview_version, ts)                    AS version,
      argMax(report_mode, ts)                          AS report_mode,
      argMax(totals['records'], ts)                    AS records,
      argMax(totals['users'], ts)                      AS users,
      argMax(totals['spaces'], ts)                     AS spaces,
      argMax(totals['lexicons'], ts)                   AS lexicons,
      argMax(totals['events.script.error'], ts)        AS script_errors
    FROM instance_snapshots
    GROUP BY instance_id
    ORDER BY last_seen DESC
  ]])
  if not rows then return failure("Upstream", err) end

  local instances = {}
  for _, r in ipairs(rows) do
    instances[#instances + 1] = {
      instanceId = r.instance_id,
      lastSeen = r.last_seen,
      version = r.version,
      reportMode = r.report_mode,
      records = int(r.records),
      users = int(r.users),
      spaces = int(r.spaces),
      lexicons = int(r.lexicons),
      scriptErrors = int(r.script_errors),
    }
  end

  local consent_rows = query(ctx, [[
    SELECT
      count()                                    AS total,
      countIf(contact IS NOT NULL)               AS with_contact,
      countIf(length(lexicon_names) > 0)         AS with_lexicon_names,
      countIf(length(host) > 0)                  AS with_host
    FROM (
      SELECT
        argMax(contact, ts)       AS contact,
        argMax(lexicon_names, ts) AS lexicon_names,
        argMax(host, ts)          AS host
      FROM instance_snapshots
      GROUP BY instance_id
    )
  ]]) or {}
  local c = consent_rows[1] or {}

  return {
    instances = json.to_array(instances),
    consent = {
      total = int(c.total),
      withContact = int(c.with_contact),
      withLexiconNames = int(c.with_lexicon_names),
      withHost = int(c.with_host),
    },
  }
end
