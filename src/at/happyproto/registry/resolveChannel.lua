-- @prelude registry
--
-- xrpc.query:at.happyproto.registry.resolveChannel
--
-- The version a plugin's channel points at. A version that is no longer
-- installable is answered with its state rather than passed over for an
-- older one: only the publisher may move a channel, and an install that
-- silently fell back would be one nobody chose.

local db = require("happyview.db")

function handle(input, ctx)
  local our_did = happyproto_did(ctx)
  if not our_did then return failure("NotConfigured", "the registry has no identity configured") end

  local did, name, channel = input.did, input.name, input.channel
  local row = is_did(did) and is_project_name(name) and is_channel_name(channel)
    and db.get(uri_of(did, CHANNEL, name .. ":" .. channel)) or nil
  -- A record whose own name disagrees with its key is no channel, as
  -- getProject leaves it out too, and nor is one the publisher deleted.
  if not row or type(row.record) ~= "table" or row.record.name ~= channel
    or channel_deleted(our_did, did, name, channel) then
    return failure("ChannelNotFound", "the project has no channel of that name indexed")
  end

  -- Only a version of this same project in this same repo: a channel row the
  -- gateway mirrored was never checked by the channel indexer.
  local ref = row.record.version
  local version_did, collection, rkey
  if type(ref) == "table" then version_did, collection, rkey = parse_uri(ref.uri) end
  local version_name, version = split_rkey(rkey)
  local view = version_did == did and collection == VERSION and version_name == name
    and is_release_version(version) and version_view(our_did, did, name, version, { refresh = true }) or nil
  if not view then
    return failure("VersionNotFound", "the channel points at a version the registry has not indexed")
  end
  return view
end
