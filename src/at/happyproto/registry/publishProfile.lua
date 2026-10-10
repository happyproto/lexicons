-- at.happyproto.registry.publishProfile
--
-- Check a package profile, and optionally write it to the caller's repo.
--
-- The indexer validates a profile only after it has been published, and skips
-- an invalid one quietly -- which is right for a firehose, where there is
-- nobody to tell, but it means a publisher writing the record itself learns
-- nothing. This answers the same refusal while the record can still be fixed.
--
-- Two sets of rules apply and both are reported: the lexicon's, via
-- `record.validate`, and the registry's own, via `profile_problem` -- the
-- function the indexer calls, so what is accepted here is what will index.

-- @prelude registry, failure

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

  -- The lexicon's own rules, so a missing required field is named here rather
  -- than by the PDS on write -- or not at all, under validateOnly.
  local ok, err = pcall(record.validate, PROFILE_COLLECTION, body)
  if not ok then
    return failure("InvalidRecord", tostring(err))
  end

  if input.validateOnly then
    return { valid = true }
  end

  if not ctx.caller_did then
    return failure(
      "AuthRequired",
      "your identity could not be determined, so there is no repo to write to"
    )
  end

  -- validate = false: the record was checked above against the lexicon and
  -- the registry's rules. Left on, HappyView also asks the PDS to require the
  -- lexicon, and a PDS has never heard of at.happyproto.*, so it refuses the
  -- write with `Lexicon not found`.
  local wrote, written =
    pcall(record.create, PROFILE_COLLECTION, body, { rkey = slug, validate = false })
  if not wrote then
    -- The reason can name the caller's session or their PDS, so it is logged
    -- rather than returned.
    log.warn("registry: publishProfile could not write", {
      did = ctx.caller_did, slug = slug, error = tostring(written),
    })
    return failure("Upstream", "the record could not be written to your repo")
  end

  return { valid = true, uri = written.uri, cid = written.cid }
end
