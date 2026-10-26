-- @prelude release, authority
--
-- job.run:registry.copy-version
--
-- Copies the blobs of one version's plugin artifact from the publisher's PDS
-- into this instance, and makes the version available once its package and
-- manifest are held. Enqueued by record.index:software.release.version with
-- `{ did, name, version }`.
--
-- This is a job and not part of the indexer because a record event runs under
-- the instruction budget and a 16 MiB package would spend it, and because a
-- publisher's unreachable PDS should fail a job that can be retried, rather
-- than dead-letter a record event that was itself valid.
--
-- The indexer enqueues none for a version deleted at its source;
-- retryVersion may, and then only what is still fetchable is kept.
--
-- A version is listed only once this job has run: the indexer writes its
-- state `pending` and only this moves it to `available`, so the registry
-- never lists a version whose bytes it does not hold, and never holds bytes
-- that don't hash to the CID the publisher's record declared.

local log = require("internal.logging")
local db = require("happyview.db")
local record = require("happyview.record")

--- Every blob of the artifact as `{kind, blob, types, max}`, in a
--- fixed order. The package and the manifest are the release; the images
--- only present it, so one failing never keeps a working plugin unlisted.
local function blobs_of(a)
  local out = {
    { kind = "package", blob = a.package, types = { ["application/wasm"] = true }, max = MAX_PACKAGE },
    { kind = "manifest", blob = a.manifest, types = { ["application/json"] = true }, max = MAX_MANIFEST },
  }
  if type(a.banner) == "table" then
    out[#out + 1] = { kind = "banner", blob = a.banner.image, types = IMAGE_TYPES, max = MAX_IMAGE }
  end
  if type(a.screenshots) == "table" then
    for i, shot in ipairs(a.screenshots) do
      if type(shot) == "table" then
        out[#out + 1] = { kind = "screenshot." .. i, blob = shot.image, types = IMAGE_TYPES, max = MAX_IMAGE }
      end
    end
  end
  return out
end

local function declared_cid(b)
  return type(b) == "table" and type(b.ref) == "table" and b.ref["$link"] or nil
end

function handle(input, ctx)
  local our_did = happyproto_did(ctx)
  if not our_did then
    error("HAPPYPROTO_DID is unset or malformed, so the version's state cannot be written")
  end

  local did, name, version = input.did, input.name, input.version
  local rkey = version_state_rkey(did, name, version)
  local state_uri = uri_of(our_did, VERSION_STATE, rkey)
  local row = db.get(state_uri)
  if not row or type(row.record) ~= "table" then
    error("no version state at " .. state_uri .. "; the indexer writes one before it enqueues this job")
  end
  local state = row.record

  -- The manifest the version pinned, by the CID the indexer checked. Manifest
  -- rows are never replaced, so a different CID here means the index is not
  -- what the version vouched for, and nothing is copied on its word.
  local pinned = state.manifestCid
  local manifest = type(state.manifestUri) == "string" and db.get(state.manifestUri) or nil
  if not manifest or manifest.cid ~= pinned then
    error("the manifest " .. tostring(state.manifestUri) .. " is not stored at the CID the version pinned")
  end
  local artifact, problem = manifest_artifact(manifest.record)
  if not artifact then
    error("the manifest of " .. rkey .. " has no plugin artifact: " .. problem)
  end

  local previous = type(state.held) == "table" and state.held or {}
  local copied, failed = {}, {}
  for _, item in ipairs(blobs_of(artifact)) do
    local held = previous[item.kind]
    -- Held only counts for the CID declared now: an entry for any other CID
    -- is not these bytes.
    if not (type(held) == "table" and held.cid ~= nil and held.cid == declared_cid(item.blob)) then
      local result, why = copy_blob(did, item.blob, item.types, item.max)
      if result then
        copied[item.kind] = result
      else
        failed[item.kind] = why
        log.warn("registry: a release blob was not copied", {
          did = did, name = name, version = version, kind = item.kind, problem = why,
        })
      end
    end
  end

  -- Read again before writing: the fetches take time, and a rewrite or a
  -- delete the indexer marked meanwhile must survive this write.
  local fresh = db.get(state_uri)
  local current = fresh and type(fresh.record) == "table" and fresh.record or state
  -- The version was written again against another manifest meanwhile. What
  -- was copied belongs to the old one, so none of it is merged; the retry
  -- copies for the manifest the version pins now.
  if current.manifestCid ~= pinned then
    error("the manifest of " .. rkey .. " changed while its blobs were copied")
  end
  local held = type(current.held) == "table" and current.held or {}
  local failures = type(current.failed) == "table" and current.failed or {}
  for kind, result in pairs(copied) do
    held[kind] = result
    failures[kind] = nil
  end
  for kind, why in pairs(failed) do failures[kind] = why end
  current.held = held
  current.failed = next(failures) and failures or nil

  -- A version deleted at its source stays so, and `suspect` is the
  -- indexer's alone, never touched here.
  if held.package and held.manifest and current.availability ~= "deletedAtSource" then
    current.availability = "available"
  end
  record.save_local(VERSION_STATE, rkey, current, our_did)

  local fatal = {}
  if failed.package then fatal[#fatal + 1] = "package: " .. failed.package end
  if failed.manifest then fatal[#fatal + 1] = "manifest: " .. failed.manifest end
  -- A version deleted at its source is copied only when an operator asks
  -- (retryVersion): whatever its PDS still answers for is kept above, so
  -- installs can keep reloading it by CID, and it is never made available.
  -- A blob the PDS no longer has is what deletion means, so it is no
  -- failure to retry.
  if #fatal > 0 and current.availability ~= "deletedAtSource" then
    -- Raised after the write, so what did verify is kept and the retry
    -- fetches only what is missing.
    error("could not copy " .. rkey .. " (" .. table.concat(fatal, "; ") .. ")")
  end

  log.info("registry: release blobs copied", {
    did = did, name = name, version = version, availability = current.availability,
  })
  return { availability = current.availability, failed = current.failed }
end
