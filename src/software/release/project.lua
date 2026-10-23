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
local db = require("happyview.db")

--- The record without `renamedTo`, to compare the rest of it.
local function without_rename(r)
  local out = {}
  for k, v in pairs(r) do
    if k ~= "renamedTo" then out[k] = v end
  end
  return out
end

function handle(input, ctx)
  if not happyproto_did(ctx) then
    error("HAPPYPROTO_DID is unset or malformed, so registry state cannot be written")
  end
  if input.action == "delete" then return nil end

  local did, name, r = input.did, input.rkey, input.record
  if not is_project_name(name) or type(r) ~= "table" or r.name ~= name then
    log.info("registry: project key is not its name", { did = did, rkey = name })
    return nil
  end
  if r.renamedTo ~= nil and select(2, parse_uri(r.renamedTo)) ~= PROJECT then
    log.info("registry: project renamedTo is not a project", { did = did, name = name })
    return nil
  end
  if not db.get(uri_of(did, SIDECAR, name)) then
    log.info("registry: project has no plugin sidecar", { did = did, name = name })
    return nil
  end

  local stored = db.get(input.uri)
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
