-- at.happyproto.registry.publishRelease
--
-- Check a release, and optionally write it to the caller's repo.
--
-- The indexer validates a release only after it has been published, and skips
-- an invalid one quietly -- which is right for a firehose, where there is
-- nobody to tell, but it means a publisher writing the record itself learns
-- nothing. This answers the same refusal while the record can still be fixed.
--
-- Two sets of rules apply and both are reported: the lexicon's, via
-- `record.validate`, and the registry's own, via `release_problem` -- the
-- function the indexer calls, so what is accepted here is what will index.

-- @prelude registry, failure

local db = require("happyview.db")
local record = require("happyview.record")
local log = require("internal.logging")

function handle(input, ctx)
  local our_did = happyproto_did(ctx)
  if not our_did then
    return failure("NotConfigured", "the registry has no identity configured")
  end

  local body = input.record
  if type(body) ~= "table" then
    return failure("InvalidRecord", "the record has no body")
  end

  -- The record key is the record's own package and version, which is what the
  -- release lexicon requires of them. Deriving it rather than taking it means
  -- the two cannot be given inconsistently.
  local slug, version = body.package, body.version
  if not is_plugin_slug(slug) then
    return failure("InvalidRecord", "package is not a package slug")
  end
  if not is_plugin_version(version) then
    return failure("InvalidRecord", "version is not a semver version without build metadata")
  end

  local problem = release_problem(body, slug, version)
  if problem then
    return failure("InvalidRecord", problem)
  end

  local ok, err = pcall(record.validate, RELEASE_COLLECTION, body)
  if not ok then
    return failure("InvalidRecord", tostring(err))
  end

  -- A release indexes against its profile, so one published without it would
  -- never appear. Checked against the index rather than the repo: the index is
  -- what a reader sees, and a profile the firehose has not delivered yet is
  -- indistinguishable from one that does not exist.
  local caller = ctx.caller_did
  if caller and not db.get("at://" .. caller .. "/" .. PROFILE_COLLECTION .. "/" .. slug) then
    return failure(
      "ProfileMissing",
      "no profile is indexed at that slug, so this release would index against nothing"
    )
  end

  -- A withdrawn version can never be published again; the indexer would skip
  -- it quietly. Read from the tombstone rather than the release row, which an
  -- instance may no longer index. Checked before validateOnly so a dry run
  -- says so too.
  if caller then
    local state = db.get("at://" .. our_did .. "/" .. RELEASE_STATE .. "/"
      .. release_state_rkey(caller, slug, version))
    if state and state.record and state.record.status == "deleted" then
      return failure("VersionExists", "that version was withdrawn and can never be published again; publish a new one")
    end
  end

  if input.validateOnly then
    return { valid = true }
  end

  if not caller then
    return failure(
      "AuthRequired",
      "your identity could not be determined, so there is no repo to write to"
    )
  end

  -- A version is immutable once released, so this refuses rather than
  -- overwrites. `create` would be refused by the PDS anyway, but it answers
  -- about a record key where this answers about a version.
  local rkey = slug .. ":" .. version
  if db.get("at://" .. caller .. "/" .. RELEASE_COLLECTION .. "/" .. rkey) then
    return failure("VersionExists", "that version is already published; publish a new one")
  end

  -- validate = false: the record was checked above against the lexicon and
  -- the registry's rules. Left on, HappyView also asks the PDS to require the
  -- lexicon, and a PDS has never heard of at.happyproto.*, so it refuses the
  -- write with `Lexicon not found`.
  local wrote, written =
    pcall(record.create, RELEASE_COLLECTION, body, { rkey = rkey, validate = false })
  if not wrote then
    -- The reason can name the caller's session or their PDS, so it is logged
    -- rather than returned.
    log.warn("registry: publishRelease could not write", {
      did = caller, slug = slug, version = version, error = tostring(written),
    })
    return failure("Upstream", "the record could not be written to your repo")
  end

  return { valid = true, uri = written.uri, cid = written.cid }
end
