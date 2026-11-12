-- @prelude release, authority
--
-- record.index:software.release.channel
--
-- Indexes a channel of a plugin project: `<name>.<channel>`, naming its own
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
    -- Nor for a project with no sidecar row: its channels resolve nothing.
    if name and is_channel_name(channel) and db.get(uri) and db.get(uri_of(did, SIDECAR, name)) then
      local state = project_state(our_did, did, name) or {}
      state.deletedChannels = type(state.deletedChannels) == "table" and state.deletedChannels or {}
      state.deletedChannels[channel] = true
      save_project_state(our_did, did, name, state)
      log.info("registry: channel deleted; it no longer resolves", { did = did, rkey = input.rkey })
    end
    return nil
  end

  local problem = channel_record_problem(our_did, did, name, channel, r)
  if problem then
    log.info("registry: channel refused", { did = did, rkey = input.rkey, reason = problem })
    return nil
  end

  index_channel(our_did, did, name, channel)
  return true
end
