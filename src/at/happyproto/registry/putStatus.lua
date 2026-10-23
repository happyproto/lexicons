-- at.happyproto.registry.putStatus
--
-- Add a software.release.status about one of the caller's projects or
-- versions. Statuses are never edited or deleted: to cancel one, add another
-- with status `withdrawn` naming it in `withdraws`.
--
-- Held to the rules the status indexer applies, so a status the registry
-- would skip is refused here instead of being written and silently ignored.

-- @prelude registry

local db = require("happyview.db")
local log = require("internal.logging")

--- The project a subject belongs to, or nil when it is not a project or
--- version of `did`.
local function subject_project(did, subject)
  local subject_did, collection, rkey = parse_uri(subject)
  if subject_did ~= did then return nil end
  if collection == PROJECT and is_project_name(rkey) then return rkey end
  if collection == VERSION then
    local name, version = split_rkey(rkey)
    if name and is_release_version(version) then return name end
  end
  return nil
end

function handle(input, ctx)
  local our_did = happyproto_did(ctx)
  if not our_did then
    return failure("NotConfigured", "the registry has no identity configured")
  end

  local status = input.status
  if type(status) ~= "string" or status == "" or #status > 64 then
    return failure("InvalidStatus", "status must be an event type of 1 to 64 characters")
  end
  if status == "supersededBy" and not is_release_version(input.supersededBy) then
    return failure("InvalidStatus", "a supersededBy status needs supersededBy, the version to use instead")
  end
  if status == "withdrawn" and type(input.withdraws) ~= "string" then
    return failure("InvalidStatus", "a withdrawn status needs withdraws, the status it cancels")
  end
  if input.kind ~= nil and (type(input.kind) ~= "string" or #input.kind > 64) then
    return failure("InvalidRecord", "kind must be a string of at most 64 characters")
  end
  if input.reason ~= nil then
    local problem = text_problem(input.reason, "reason", 300, 3000)
    if problem then return failure("InvalidRecord", problem) end
  end

  local caller = ctx.caller_did
  if not caller then
    return failure(
      "AuthRequired",
      "your identity could not be determined, so there is no repo to write to"
    )
  end

  -- Only a publisher's statuses about their own indexed releases count, and
  -- only while the project is a plugin.
  local subject = input.subject
  local name = subject_project(caller, subject)
  if not name or not db.get(subject) or not live_sidecar(our_did, caller, name) then
    return failure("SubjectNotFound", "subject is not an indexed plugin project or version of yours")
  end

  if status == "withdrawn" then
    local target_did, collection = parse_uri(input.withdraws)
    local target = target_did == caller and collection == STATUS and db.get(input.withdraws) or nil
    if not target then
      return failure("SubjectNotFound", "withdraws is not an indexed status of yours")
    end
    -- A withdrawal is applied among one subject's statuses, so one naming a
    -- status about something else would be written and mean nothing.
    if (target.record or {}).subject ~= subject then
      return failure("InvalidStatus", "withdraws must name a status about the same subject")
    end
  end

  local written, err = caller_write("create", STATUS, {
    ["$type"] = STATUS,
    subject = subject,
    status = status,
    kind = input.kind,
    reason = input.reason,
    supersededBy = status == "supersededBy" and input.supersededBy or nil,
    withdraws = status == "withdrawn" and input.withdraws or nil,
  }, {})
  if not written then
    log.warn("registry: putStatus could not write the status", { did = caller, subject = subject, error = err })
    return failure("Upstream", "the status could not be written to your repo; the same call can be made again")
  end
  return written
end
