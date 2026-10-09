-- @prelude registry, failure
--
-- xrpc.query:at.happyproto.registry.getArtifact
--
-- An artifact's bytes, from the registry's own copy. Never a redirect to the
-- publisher: an instance talks to registries only, and a publisher who
-- deletes a release or loses a PDS must not be able to break an install.
--
-- The lexicon declares `output.encoding: "*/*"`, which is what makes this
-- answer bytes at all -- a method declaring `application/json` is never read
-- for the byte forms. Returning a blob ref hands the host a CID and lets it
-- send the content, so a multi-megabyte module never passes through this
-- script.
--
-- A withdrawn release still serves its bytes. That is the whole point of
-- keeping them.

local db = require("happyview.db")

function handle(input, ctx)
  local our_did = happyproto_did(ctx)
  if not our_did then return failure("NotConfigured", "the registry has no identity configured") end

  local did, slug, version = input.did, input.slug, input.version
  local kind = input.type
  if kind == nil or kind == "" then kind = "package" end

  if not is_did(did) or not is_plugin_slug(slug) or not is_plugin_version(version) then
    return failure("ReleaseNotFound", "no release is indexed at that version")
  end

  local state = db.get("at://" .. our_did .. "/" .. RELEASE_STATE .. "/"
    .. release_state_rkey(did, slug, version))
  if not state then
    return failure("ReleaseNotFound", "no release is indexed at that version")
  end

  local artifact = (state.record.held or {})[kind]
  if not artifact or not artifact.cid then
    -- Either the copy has not run yet, or this release never published that
    -- artifact type. Both are "we do not hold it", and neither is a 404 on
    -- the release itself.
    return failure("ArtifactNotHeld",
      "the registry holds no " .. kind .. " artifact for that version")
  end

  return {
    ["$type"] = "blob",
    ref = { ["$link"] = artifact.cid },
    mimeType = artifact.mimeType,
    size = artifact.size,
  }
end
