-- at.happyproto.registry.promoteRelease
--
-- Publish an existing version's artifact under a new version, such as
-- `1.2.0-rc.1` as `1.2.0`, without uploading it again: the new
-- software.release.version points at the same manifest, by the same
-- strongRef. Optionally moves a channel to it and adds a changelog.
--
-- Written in the order publishRelease writes, the changelog, the version and
-- then the channel, so a failure part-way leaves no reference to nothing.
-- The same call made again finishes the promotion: a new version already on
-- the same manifest only has its channel moved.

-- @prelude registry

local db = require("happyview.db")
local log = require("internal.logging")

local function same_ref(a, b)
  return type(a) == "table" and type(b) == "table" and a.uri == b.uri and a.cid == b.cid
end

function handle(input, ctx)
  local our_did = happyproto_did(ctx)
  if not our_did then
    return failure("NotConfigured", "the registry has no identity configured")
  end

  local name, from, version, track = input.name, input.fromVersion, input.version, input.track
  if not is_project_name(name) then
    return failure("InvalidRecord", "name must be 1 to 64 lowercase letters, digits and interior hyphens")
  end
  if not is_release_version(from) then
    return failure("InvalidRecord", "fromVersion is not a semver version without build metadata")
  end
  if not is_release_version(version) then
    return failure("InvalidRecord", "version is not a semver version without build metadata")
  end
  if track ~= nil and not TRACKS[track] then
    return failure("InvalidRecord", "track must be latest, beta or alpha")
  end
  local problem = changelog_problem(input.changelog)
  if problem then return failure("InvalidRecord", problem) end
  local changelog = input.changelog ~= "" and input.changelog or nil

  local caller = ctx.caller_did
  if not caller then
    return failure(
      "AuthRequired",
      "your identity could not be determined, so there is no repo to write to"
    )
  end

  if not live_sidecar(our_did, caller, name) or not db.get(uri_of(caller, PROJECT, name)) then
    return failure(
      "ProjectMissing",
      "no plugin project of that name is indexed for you; call putProject first"
    )
  end

  local from_row = db.get(uri_of(caller, VERSION, release_rkey(name, from)))
  local manifest = from_row and (from_row.record or {}).manifest
  if type(manifest) ~= "table" or type(manifest.uri) ~= "string" or type(manifest.cid) ~= "string" then
    return failure("VersionNotFound", "fromVersion is not an indexed version of your project")
  end
  manifest = { uri = manifest.uri, cid = manifest.cid }
  -- fromVersion is indexed, so VersionNotFound would be untrue; it is the
  -- input that breaks a registry rule, since a version on this manifest
  -- would be served `suspect`, which HappyView refuses to install, or with
  -- no bytes to copy.
  if manifest_marked(our_did, caller, name, manifest.uri) then
    return failure("InvalidRecord", "fromVersion's manifest was rewritten or deleted at its source, so a version on it could not be installed")
  end

  -- A version never changes once published. One already on this manifest is
  -- an earlier call of this one that failed part-way.
  local existing = db.get(uri_of(caller, VERSION, release_rkey(name, version)))
  if existing and not same_ref((existing.record or {}).manifest, manifest) then
    return failure("VersionExists", "that version is already published; publish a new one")
  end

  -- The new version has no statuses of its own until it is written, so
  -- whether a channel may point at it is the project's to say.
  if track and not release_lifecycle(caller, name, existing and version).installable then
    return failure("NotInstallable", "the project is unavailable or retired, so no channel can move to a new version")
  end

  local function refused(what, err)
    log.warn("registry: promoteRelease could not write the " .. what, {
      did = caller, name = name, version = version, error = err,
    })
    return failure(
      "Upstream",
      "the " .. what .. " could not be written to your repo; what was written before it stays, and the same call can be made again"
    )
  end

  local project_uri = uri_of(caller, PROJECT, name)
  local out = {}
  local err

  if existing then
    out.resumed = true
    out.version = { uri = existing.uri, cid = existing.cid }
    -- The document's CID is known only from its row, which the write that
    -- created it mirrored into the index.
    local changelog_uri = (existing.record or {}).changelog
    local doc = type(changelog_uri) == "string" and db.get(changelog_uri) or nil
    if doc and type(doc.cid) == "string" and doc.cid ~= "" then
      out.changelog = { uri = changelog_uri, cid = doc.cid }
    end
  else
    if changelog then
      out.changelog, err = caller_write("create", DOCUMENT,
        changelog_document(caller, name, version, display_name(our_did, caller, name), changelog), {})
      if not out.changelog then return refused("changelog", err) end
    end

    out.version, err = caller_write("create", VERSION, {
      ["$type"] = VERSION,
      project = project_uri,
      version = version,
      manifest = manifest,
      changelog = out.changelog and out.changelog.uri or nil,
    }, { rkey = release_rkey(name, version) })
    if not out.version then return refused("version", err) end
  end

  if track then
    out.channel, err = caller_write("put", uri_of(caller, CHANNEL, release_rkey(name, track)), {
      ["$type"] = CHANNEL,
      project = project_uri,
      channel = track,
      version = { uri = out.version.uri, cid = out.version.cid },
    }, {})
    if not out.channel then return refused("channel", err) end
  end

  return out
end
