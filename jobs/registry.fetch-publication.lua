-- @prelude release, authority
--
-- job.run:registry.fetch-publication
--
-- Caches a project's site.standard.publication (its display name,
-- description, link and icon) on the project's PROJECT_STATE row. Enqueued
-- by record.index:at.happyproto.registry.project with `{ did, name, uri, cid }`
-- whenever a sidecar is stored.
--
-- The registry does not index site.standard records, so this is the only
-- copy it has. The sidecar pins the publication by CID, and only that exact
-- record is cached: a publication edited without a sidecar update is not
-- something the publisher's plugin record vouched for.

local log = require("internal.logging")
local db = require("happyview.db")

--- The cached publication, or nil and why. Only what the views show is kept,
--- and only in shapes a page can render safely.
--- The uri is the pinned one, never the one the PDS answered with: the CID
--- was checked against the pin, and the uri is the PDS's to misreport.
---
--- Bounds are generous against the lexicon's own, since only another PDS
--- would answer more, but they keep one publisher from filling the cache.
local MAX_NAME_BYTES = 5000
local MAX_DESCRIPTION_BYTES = 30000

local function publication_of(pin, fetched)
  local v = fetched.value
  if type(v.name) ~= "string" or v.name == "" then return nil, "it has no name" end
  if #v.name > MAX_NAME_BYTES then return nil, "its name is longer than " .. MAX_NAME_BYTES .. " bytes" end
  if not is_web_url(v.url) then return nil, "its url is not a web link" end
  if v.description ~= nil and type(v.description) ~= "string" then
    return nil, "its description is not text"
  end
  if v.description ~= nil and #v.description > MAX_DESCRIPTION_BYTES then
    return nil, "its description is longer than " .. MAX_DESCRIPTION_BYTES .. " bytes"
  end
  return { uri = pin.uri, cid = fetched.cid, name = v.name, description = v.description, url = v.url }
end

function handle(input, ctx)
  local our_did = happyproto_did(ctx)
  if not our_did then
    error("HAPPYPROTO_DID is unset or malformed, so the project's state cannot be written")
  end

  local did, name = input.did, input.name
  -- The sidecar as it is now, not as it was when this job was queued: a
  -- later update pins a newer publication, and that is the one to cache.
  local sidecar = live_sidecar(our_did, did, name)
  local pin = sidecar and type(sidecar.record) == "table" and sidecar.record.publication
  if type(pin) ~= "table" or type(pin.cid) ~= "string" then
    log.info("registry: no live sidecar pins a publication", { did = did, name = name })
    return { skipped = "no sidecar" }
  end
  local pinned_did, collection = parse_uri(pin.uri)
  if pinned_did ~= did or collection ~= PUBLICATION then
    log.warn("registry: sidecar pins something other than its own publication", {
      did = did, name = name, uri = pin.uri,
    })
    return { skipped = "not a publication" }
  end

  local fetched, problem = pds_record(pin.uri)
  if not fetched then
    -- Raised, so the job is retried: the publisher's PDS may be down.
    error("could not fetch " .. pin.uri .. ": " .. tostring(problem))
  end
  if fetched.cid ~= pin.cid then
    -- Either the publication changed after the sidecar pinned it, and the
    -- sidecar update that pins the new one queues its own fetch, or the PDS
    -- is answering with something the sidecar never vouched for.
    log.warn("registry: publication is not the one its sidecar pins", {
      did = did, name = name, pinned = pin.cid, fetched = fetched.cid,
    })
    return { skipped = "cid mismatch" }
  end

  local publication, refused = publication_of(pin, fetched)
  if not publication then
    log.warn("registry: publication refused", { did = did, name = name, problem = refused })
    return { skipped = refused }
  end

  -- The icon is copied like any release blob and named by its CID only once
  -- the bytes verify. One already cached under the same CID is not fetched
  -- again. Its type is kept beside it, because the store holds every copied
  -- blob as application/octet-stream and the view must say what it is.
  local cached = project_state(our_did, did, name)
  local before = cached and type(cached.publication) == "table" and cached.publication or {}
  local icon = fetched.value.icon
  local declared = type(icon) == "table" and type(icon.ref) == "table" and icon.ref["$link"] or nil
  if declared ~= nil and declared == before.icon and IMAGE_TYPES[before.iconMimeType] then
    publication.icon, publication.iconMimeType = declared, before.iconMimeType
  elseif icon ~= nil then
    local copied, why = copy_blob(did, icon, IMAGE_TYPES, MAX_IMAGE)
    if copied then
      publication.icon, publication.iconMimeType = copied.cid, copied.mimeType
    else
      log.warn("registry: publication icon was not copied", { did = did, name = name, problem = why })
    end
  end

  -- Read again just before writing, since the row is shared with the
  -- sidecar indexer and the manifest marks, and keep every field but ours.
  local state = project_state(our_did, did, name) or {}
  state.publication = publication
  state.fetchedAt = now_iso()
  save_project_state(our_did, did, name, state)
  return { publication = publication }
end
