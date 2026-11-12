-- @prelude release, authority
--
-- record.index:software.release.status
--
-- Indexes a lifecycle statement about a stored version or project of a plugin,
-- made by the repo that owns it. Statuses are append-only, so an update is
-- refused and the first record stays.
--
-- What `lifecycle` reads from a status is checked here, so a stored status
-- always means what it says: `supersededBy` names a version when that is the
-- event, and a withdrawal names a stored status about the same subject, the
-- only kind `lifecycle` can apply.

local log = require("internal.logging")

function handle(input, ctx)
  local our_did = happyproto_did(ctx)
  if not our_did then
    error("HAPPYPROTO_DID is unset or malformed, so registry state cannot be written")
  end
  if input.action == "delete" then return nil end

  local stored = prior_row(input.uri, input.record)
  if input.action == "update" or (stored and not same_value(stored.record, input.record)) then
    log.warn("registry: status changed after publication; keeping the first", { uri = input.uri })
    return nil
  end
  -- A create matching the stored row is a replayed cursor.
  if stored then return nil end

  local problem = status_record_problem(our_did, input.did, input.record)
  if problem then
    log.info("registry: status refused", { uri = input.uri, reason = problem })
    return nil
  end
  return true
end
