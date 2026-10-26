-- @prelude release, authority
--
-- record.index:software.release.channel
--
-- Indexes a channel of a plugin project: `<name>:<channel>`, naming its own
-- project and pinning, by CID, a stored version of that same project in the
-- same repo. Channels move, so an update is indexed like a create, under the
-- same checks.
--
-- A delete keeps the row, like every release record's, so it is marked on
-- the project's state instead (`deletedChannels`), and a channel marked so
-- no longer resolves. Writing the channel again, and indexing it, clears the
-- mark.

local log = require("internal.logging")
local db = require("happyview.db")

function handle(input, ctx)
  local our_did = happyproto_did(ctx)
  if not our_did then
    error("HAPPYPROTO_DID is unset or malformed, so registry state cannot be written")
  end
  local did, uri, r = input.did, input.uri, input.record
  local name, channel = split_rkey(input.rkey)

  if input.action == "delete" then
    -- Only a channel the registry stored has anything to hide; marking any
    -- other would let anyone write state rows by deleting what never was.
    if name and is_channel_name(channel) and db.get(uri) then
      local state = project_state(our_did, did, name) or {}
      state.deletedChannels = type(state.deletedChannels) == "table" and state.deletedChannels or {}
      state.deletedChannels[channel] = true
      save_project_state(our_did, did, name, state)
      log.info("registry: channel deleted; it no longer resolves", { did = did, rkey = input.rkey })
    end
    return nil
  end

  if not name or not is_channel_name(channel) or type(r) ~= "table"
    or r.name ~= channel or r.project ~= uri_of(did, PROJECT, name) then
    log.info("registry: channel does not match its key", { did = did, rkey = input.rkey })
    return nil
  end
  if not live_sidecar(our_did, did, name) then
    log.info("registry: channel's project has no plugin sidecar", { uri = uri, name = name })
    return nil
  end

  local ref = r.version
  local version_did, collection
  if type(ref) == "table" then version_did, collection = parse_uri(ref.uri) end
  local target = version_did == did and collection == VERSION and db.get(ref.uri) or nil
  if not target or type(ref.cid) ~= "string" or target.cid ~= ref.cid
    or (target.record or {}).project ~= r.project then
    log.info("registry: channel's version is not a stored version of its project", { uri = uri })
    return nil
  end

  local state = project_state(our_did, did, name)
  if state and type(state.deletedChannels) == "table" and state.deletedChannels[channel] then
    state.deletedChannels[channel] = nil
    if next(state.deletedChannels) == nil then state.deletedChannels = nil end
    save_project_state(our_did, did, name, state)
  end
  return true
end
