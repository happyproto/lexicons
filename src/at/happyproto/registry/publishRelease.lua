-- at.happyproto.registry.publishRelease
--
-- Publish a version of a plugin to the caller's repo: the
-- software.release.manifest carrying the artifact, the changelog as a
-- site.standard.document when one is given, the software.release.version, and
-- the channel named by `track`, moved to it.
--
-- There is no batch write, so they are written one at a time, each only once
-- everything it points at exists: a failure part-way leaves records nothing
-- references yet, never a reference to nothing. The same call made again
-- finishes the release. A manifest already written for the same artifact is
-- reused rather than written twice, and a version already written for it
-- only has its channel moved.
--
-- Two calls for one version at the same time can each find no manifest to
-- reuse and write one. Only one version write succeeds, so the other
-- manifest is left unreferenced: never served, and harmless.
--
-- The artifact is checked with the rules the indexer applies, so a release
-- the registry would skip is refused here, where the publisher can still fix
-- it.

-- @prelude registry

local db = require("happyview.db")
local log = require("internal.logging")

--- The newest manifests are searched, since a retry follows the call that
--- wrote one closely. The write is mirrored into the index at once, so it is
--- found before the network delivers it.
local REUSE_WINDOW = 100

--- A manifest of the caller's for this project that carries exactly this
--- artifact, as `{uri, cid}`, or nil. One the registry saw rewritten or
--- deleted at its source is never reused: a version on it would never be
--- served.
local function reusable_manifest(our_did, caller, name, artifact)
  local wanted = canonical_json(artifact)
  local page = db.records(MANIFEST):did(caller)
    :where("project", "=", uri_of(caller, PROJECT, name))
    :sort("uri", "desc"):limit(REUSE_WINDOW):run() or {}
  for _, row in ipairs(page.records or {}) do
    local found = manifest_artifact(row.record)
    if found and type(row.cid) == "string" and row.cid ~= ""
        and not manifest_marked(our_did, caller, name, row.uri)
        and canonical_json(found) == wanted then
      return { uri = row.uri, cid = row.cid }
    end
  end
  return nil
end

function handle(input, ctx)
  local our_did = happyproto_did(ctx)
  if not our_did then
    return failure("NotConfigured", "the registry has no identity configured")
  end

  local name, version, track = input.name, input.version, input.track
  if not is_project_name(name) then
    return failure("InvalidRecord", "name must be 1 to 64 lowercase letters, digits and interior hyphens")
  end
  if not is_release_version(version) then
    return failure("InvalidRecord", "version is not a semver version without build metadata")
  end
  if not TRACKS[track] then
    return failure("InvalidRecord", "track must be latest, beta or alpha")
  end
  local problem = artifact_problem(input.artifact) or changelog_problem(input.changelog)
  if problem then return failure("InvalidRecord", problem) end
  -- The indexer finds the plugin among a manifest's artifacts by its type,
  -- so it is always written, and compared, with one. A shallow copy, so the
  -- caller's input is left as it was; the nested values are only read.
  local artifact = {}
  for k, v in pairs(input.artifact) do artifact[k] = v end
  artifact["$type"] = ARTIFACT_TYPE
  local changelog = input.changelog ~= "" and input.changelog or nil

  local caller = ctx.caller_did
  local version_row, resumed_manifest
  if caller then
    local sidecar = live_sidecar(our_did, caller, name)
    if not sidecar or not db.get(uri_of(caller, PROJECT, name)) then
      return failure(
        "ProjectMissing",
        "no plugin project of that name is indexed for you, so this release would index against nothing; call putProject first"
      )
    end
    if artifact.pluginType ~= (sidecar.record or {}).pluginType then
      return failure("InvalidRecord", "pluginType must be the project's, " .. tostring((sidecar.record or {}).pluginType))
    end

    -- A version never changes once published. One already there with this
    -- very artifact is an earlier call of this one that failed part-way, and
    -- only its channel is left to move.
    version_row = db.get(uri_of(caller, VERSION, release_rkey(name, version)))
    if version_row then
      local ref = (version_row.record or {}).manifest
      local manifest = type(ref) == "table" and type(ref.uri) == "string" and db.get(ref.uri) or nil
      local existing = manifest and manifest.cid == ref.cid and manifest_artifact(manifest.record)
      if not existing or canonical_json(existing) ~= canonical_json(artifact) then
        return failure("VersionExists", "that version is already published with another artifact; publish a new one")
      end
      resumed_manifest = { uri = ref.uri, cid = ref.cid }
    end

    -- The channel is what installs follow, so it never moves to a version
    -- nobody may install.
    if not release_lifecycle(caller, name, version_row and version).installable then
      return failure("NotInstallable", "the project is unavailable or retired, so no channel can move to a new version")
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

  local function refused(what, err)
    log.warn("registry: publishRelease could not write the " .. what, {
      did = caller, name = name, version = version, error = err,
    })
    return failure(
      "Upstream",
      "the " .. what .. " could not be written to your repo; what was written before it stays, and the same call can be made again"
    )
  end

  local project_uri = uri_of(caller, PROJECT, name)
  local out = { valid = true }
  local err

  if version_row then
    out.resumed = true
    out.manifest = resumed_manifest
    out.version = { uri = version_row.uri, cid = version_row.cid }
    -- The document's CID is known only from its row, which the write that
    -- created it mirrored into the index.
    local changelog_uri = (version_row.record or {}).changelog
    local doc = type(changelog_uri) == "string" and db.get(changelog_uri) or nil
    if doc and type(doc.cid) == "string" and doc.cid ~= "" then
      out.changelog = { uri = changelog_uri, cid = doc.cid }
    end
  else
    out.manifest = reusable_manifest(our_did, caller, name, artifact)
    if not out.manifest then
      out.manifest, err = caller_write("create", MANIFEST, {
        ["$type"] = MANIFEST,
        project = project_uri,
        artifacts = { artifact },
      }, {})
      if not out.manifest then return refused("manifest", err) end
    end

    if changelog then
      out.changelog, err = caller_write("create", DOCUMENT,
        changelog_document(caller, name, version, display_name(our_did, caller, name), changelog), {})
      if not out.changelog then return refused("changelog", err) end
    end

    out.version, err = caller_write("create", VERSION, {
      ["$type"] = VERSION,
      project = project_uri,
      version = version,
      manifest = { uri = out.manifest.uri, cid = out.manifest.cid },
      changelog = out.changelog and out.changelog.uri or nil,
    }, { rkey = release_rkey(name, version) })
    if not out.version then return refused("version", err) end
  end

  out.channel, err = caller_write("put", uri_of(caller, CHANNEL, release_rkey(name, track)), {
    ["$type"] = CHANNEL,
    project = project_uri,
    channel = track,
    version = { uri = out.version.uri, cid = out.version.cid },
  }, {})
  if not out.channel then return refused("channel", err) end

  return out
end
