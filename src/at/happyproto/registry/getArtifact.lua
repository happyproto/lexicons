-- @prelude registry
--
-- xrpc.query:at.happyproto.registry.getArtifact
--
-- A blob's bytes, from the registry's own copy. Never a redirect to the
-- publisher: a publisher who deletes a release or loses a PDS must not be
-- able to break an install.
--
-- The lexicon declares `output.encoding: "*/*"`, which is what makes this
-- answer bytes at all. Returning a blob ref hands the host a CID and lets it
-- send the content, so a multi-megabyte package never passes through this
-- script. The copy job stores every blob as application/octet-stream, so the
-- ref names the type the blob was published with, and the host serves that.
--
-- Only a blob the registry holds for an indexed version, or a project's
-- cached icon, is served. The store also keeps bytes from copies that never
-- verified against their CID, and those must never be reachable, by CID or
-- otherwise.

local db = require("happyview.db")
local blobs = require("happyview.blobs")

local NOT_HELD = "the registry does not hold that blob"

--- The kind a held entry is filed under. Screenshots are held from 1, as the
--- copy job numbers them, while the lexicon counts them from 0.
local function held_kind(kind, index)
  if kind == "package" or kind == "manifest" or kind == "banner" then return kind end
  if kind ~= "screenshot" then return nil end
  local i = index == nil and 0 or math.tointeger(tonumber(index))
  if not i or i < 0 or i > 7 then return nil end
  return "screenshot." .. (i + 1)
end

local function is_cid(s)
  return type(s) == "string" and #s <= 128 and s:match("^b[a-z2-7]+$") ~= nil
end

--- `{cid, mimeType, size?}` for a CID some state row of ours holds, or nil.
local function held_by_cid(our_did, cid)
  -- A substring match narrows the rows; the exact match below decides. A
  -- CID is base32, so it carries no LIKE wildcard.
  local page = db.records(VERSION_STATE):did(our_did):where("held", "like", "%" .. cid .. "%"):limit(100):run() or {}
  for _, row in ipairs(page.records or {}) do
    local held = type(row.record) == "table" and row.record.held
    if type(held) == "table" then
      for _, entry in pairs(held) do
        if type(entry) == "table" and entry.cid == cid then return entry end
      end
    end
  end

  page = db.records(PROJECT_STATE):did(our_did):where("publication.icon", "=", cid):limit(1):run() or {}
  for _, row in ipairs(page.records or {}) do
    local publication = type(row.record) == "table" and row.record.publication
    if type(publication) == "table" and publication.icon == cid then
      return { cid = cid, mimeType = publication.iconMimeType }
    end
  end
  return nil
end

--- The held entry a version and kind name, or nil.
local function held_by_kind(our_did, input)
  local did, name = input.did, input.name
  if not is_did(did) or not is_project_name(name) then return nil end
  if input.kind == "icon" then
    local state = project_state(our_did, did, name)
    local publication = state and state.publication
    if type(publication) ~= "table" or not is_cid(publication.icon) then return nil end
    return { cid = publication.icon, mimeType = publication.iconMimeType }
  end
  local kind = held_kind(input.kind, input.index)
  if not kind or not is_release_version(input.version) then return nil end
  local row = db.get(uri_of(our_did, VERSION_STATE, version_state_rkey(did, name, input.version)))
  local held = row and type(row.record) == "table" and row.record.held
  return type(held) == "table" and held[kind] or nil
end

function handle(input, ctx)
  local our_did = happyproto_did(ctx)
  if not our_did then return failure("NotConfigured", "the registry has no identity configured") end

  local entry
  if input.cid ~= nil then
    entry = is_cid(input.cid) and held_by_cid(our_did, input.cid) or nil
  else
    entry = held_by_kind(our_did, input)
  end
  if type(entry) ~= "table" or not is_cid(entry.cid) or type(entry.mimeType) ~= "string" then
    return failure("ArtifactNotHeld", NOT_HELD)
  end

  -- Held means the bytes verified once; the store must still have them.
  local ok, stat = pcall(blobs.stat, entry.cid)
  if not ok or type(stat) ~= "table" then
    return failure("ArtifactNotHeld", NOT_HELD)
  end

  return {
    ["$type"] = "blob",
    ref = { ["$link"] = entry.cid },
    mimeType = entry.mimeType,
    size = entry.size or stat.size,
  }
end
