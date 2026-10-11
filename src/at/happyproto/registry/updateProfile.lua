-- at.happyproto.registry.updateProfile
--
-- Replace a package profile the caller has already published.
--
-- This is how a publisher edits a profile, rather than calling
-- com.atproto.repo.putRecord through HappyView: HappyView proxies a method it
-- does not host to wherever the instance's routing points, which is not
-- necessarily the caller's PDS. `happyview.record` always writes to the
-- caller's own repo, as them.
--
-- The edit is held to the rules publishProfile applies, so an edit the indexer
-- would skip is refused here instead of replacing a profile that indexed.

-- @prelude registry, failure

local db = require("happyview.db")
local record = require("happyview.record")
local log = require("internal.logging")

function handle(input, ctx)
  local our_did = happyproto_did(ctx)
  if not our_did then
    return failure("NotConfigured", "the registry has no identity configured")
  end

  local slug, body = input.slug, input.record

  local problem = profile_problem(body, slug)
  if problem then
    return failure("InvalidRecord", problem)
  end

  local ok, err = pcall(record.validate, PROFILE_COLLECTION, body)
  if not ok then
    return failure("InvalidRecord", tostring(err))
  end

  local caller = ctx.caller_did
  if not caller then
    return failure(
      "AuthRequired",
      "your identity could not be determined, so there is no repo to write to"
    )
  end

  -- An update, never a create: a put would create the record as readily as
  -- replace it, and a new profile goes through publishProfile.
  local uri = "at://" .. caller .. "/" .. PROFILE_COLLECTION .. "/" .. slug
  if not db.get(uri) then
    return failure("ProfileMissing", "no profile is indexed at that slug; publish it first")
  end

  -- validate = false for the reason publishProfile gives: the record was
  -- checked above, and a PDS asked to require at.happyproto.* refuses the
  -- write with `Lexicon not found`.
  local wrote, written =
    pcall(record.put, uri, body, { swap_cid = input.swapCid, validate = false })
  if not wrote then
    local reason = tostring(written)
    if reason:find("InvalidSwap", 1, true) then
      return failure("InvalidSwap", "the profile changed since it was read; read it again")
    end
    -- The reason can name the caller's session or their PDS, so it is logged
    -- rather than returned.
    log.warn("registry: updateProfile could not write", {
      did = caller, slug = slug, error = reason,
    })
    return failure("Upstream", "the record could not be written to your repo")
  end

  return { uri = written.uri, cid = written.cid }
end
