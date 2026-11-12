-- @prelude release, authority
--
-- record.index:software.release.project
--
-- Indexes a project only while it has a plugin sidecar: the registry lists
-- HappyView plugins, not every project on the network.
--
-- A project's key is its name and is never reused, so the one change it may
-- take after creation is gaining `renamedTo`, which turns it into an alias.
-- Anything else rewritten in place would change what every stored version and
-- channel points at without any of them changing, so it is refused and the
-- first record stays.

local log = require("internal.logging")

--- The record without `renamedTo`, to compare the rest of it.
local function without_rename(r)
  local out = {}
  for k, v in pairs(r) do
    if k ~= "renamedTo" then out[k] = v end
  end
  return out
end

function handle(input, ctx)
  local our_did = happyproto_did(ctx)
  if not our_did then
    error("HAPPYPROTO_DID is unset or malformed, so registry state cannot be written")
  end
  if input.action == "delete" then return nil end

  local did, name, r = input.did, input.rkey, input.record
  local problem = project_record_problem(our_did, did, name, r)
  if problem then
    log.info("registry: project refused", { did = did, rkey = name, reason = problem })
    return nil
  end

  -- An update to a project never stored is indexed as its first record,
  -- unlike a manifest or version: a project may legitimately be updated (to
  -- add renamedTo), so an update is no evidence of tampering by itself.
  local stored = prior_row(input.uri, input.record)
  if stored then
    if same_value(stored.record, r) then return nil end
    local old = stored.record or {}
    local renames = old.renamedTo == nil and type(r.renamedTo) == "string"
      and same_value(without_rename(old), without_rename(r))
    if not renames then
      log.warn("registry: project changed after publication; keeping the first", {
        did = did, name = name,
      })
      return nil
    end
  end
  return true
end
