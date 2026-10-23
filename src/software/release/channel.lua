-- @prelude release, authority
--
-- record.index:software.release.channel
--
-- Indexes a channel of a plugin project: `<name>:<channel>`, naming its own
-- project and pinning, by CID, a stored version of that same project in the
-- same repo. Channels move, so an update is indexed like a create, under the
-- same checks.

local log = require("internal.logging")
local db = require("happyview.db")

function handle(input, ctx)
  if not happyproto_did(ctx) then
    error("HAPPYPROTO_DID is unset or malformed, so registry state cannot be written")
  end
  if input.action == "delete" then return nil end

  local did, uri, r = input.did, input.uri, input.record
  local name, channel = split_rkey(input.rkey)
  if not name or not is_channel_name(channel) or type(r) ~= "table"
    or r.name ~= channel or r.project ~= uri_of(did, PROJECT, name) then
    log.info("registry: channel does not match its key", { did = did, rkey = input.rkey })
    return nil
  end
  if not db.get(uri_of(did, SIDECAR, name)) then
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
  return true
end
