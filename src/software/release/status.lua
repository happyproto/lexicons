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
local db = require("happyview.db")

--- Why the record cannot be indexed, or nil.
local function problem_of(our_did, did, r)
  if type(r) ~= "table" then return "the record has no body" end

  local subject_did, collection, rkey = parse_uri(r.subject)
  if subject_did ~= did then return "subject is not a record of this repo" end
  local name
  if collection == PROJECT then
    name = is_project_name(rkey) and rkey or nil
  elseif collection == VERSION then
    name = split_rkey(rkey)
  end
  if not name then return "subject is not a version or project" end
  if not live_sidecar(our_did, did, name) then return "the project has no plugin sidecar" end
  if not db.get(r.subject) then return "subject is not indexed" end

  if type(r.status) ~= "string" or r.status == "" or #r.status > 64 then
    return "status must be a string"
  end
  if r.status == "supersededBy" and not is_release_version(r.supersededBy) then
    return "supersededBy must name a version"
  end
  if r.status == "withdrawn" then
    local target_did, target_collection = parse_uri(r.withdraws)
    local target = target_did == did and target_collection == STATUS and db.get(r.withdraws) or nil
    if not target then return "withdraws must name a stored status of this repo" end
    if (target.record or {}).subject ~= r.subject then
      return "withdraws must name a status about the same subject"
    end
  end
  return nil
end

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

  local problem = problem_of(our_did, input.did, input.record)
  if problem then
    log.info("registry: status refused", { uri = input.uri, reason = problem })
    return nil
  end
  return true
end
