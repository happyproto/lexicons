-- job.run:registry.copy-artifact
--
-- Copies one release's artifact into this instance and marks the release
-- servable. Enqueued by record.index:at.happyproto.plugin.release with
-- `{ did, slug, version, uri, stateRkey }`.
--
-- This is a job and not part of the indexer for two reasons. A record event
-- runs under the instruction budget and a job runs under none, and decoding a
-- megabyte of artifact into Lua values would spend that budget. And a
-- publisher's unreachable URL should fail a job that can be retried, rather
-- than dead-letter a firehose event that was itself perfectly valid.
--
-- A release is listed only once this job has run: the indexer writes its state
-- row `pending` and only this moves it to `active`. So the registry's first
-- obligation -- never list a release whose bytes it does not hold -- holds by
-- construction rather than by a check somewhere remembering to run.
--
-- Not generated: jobs/ deploys as it is, so this file takes nothing from the
-- prelude and keeps its own small helpers.

local log = require("internal.logging")
local db = require("happyview.db")
local record = require("happyview.record")
local blobs = require("happyview.blobs")
local atproto = require("happyview.atproto")
local http = require("happyview.http")

local RELEASE_STATE = "at.happyproto.registry.releaseState"
local B32 = "abcdefghijklmnopqrstuvwxyz234567"

--- Lowercase RFC 4648 base32, no padding, as multibase 'b' uses. Answers a
--- byte array, or nil for a character outside the alphabet.
local function unbase32(s)
  local bits, out = 0, {}
  local acc, n = 0, 0
  for i = 1, #s do
    local v = B32:find(s:sub(i, i), 1, true)
    if not v then return nil end
    acc = acc * 32 + (v - 1)
    n = n + 5
    if n >= 8 then
      n = n - 8
      local byte = math.floor(acc / (2 ^ n))
      acc = acc - byte * (2 ^ n)
      out[#out + 1] = byte
    end
    bits = bits + 5
  end
  return out
end

--- The sha2-256 digest inside a multibase-'b' multihash or CID, as a hex
--- string. A declared `checksum` is a bare multihash (`0x12 0x20 <32>`) and a
--- CID adds a version and codec in front (`0x01 <codec> 0x12 0x20 <32>`), so
--- the digest is found by looking for the multihash header rather than by
--- assuming an offset. Answers nil for anything that is not sha2-256.
local function sha256_digest_hex(multibase)
  if type(multibase) ~= "string" or multibase:sub(1, 1) ~= "b" then return nil end
  local bytes = unbase32(multibase:sub(2))
  if not bytes then return nil end
  for start = 1, #bytes - 33 do
    if bytes[start] == 0x12 and bytes[start + 1] == 0x20 and #bytes - start - 1 >= 32 then
      local hex = {}
      for i = start + 2, start + 33 do hex[#hex + 1] = string.format("%02x", bytes[i]) end
      return table.concat(hex)
    end
  end
  return nil
end

local function state_fields(our_did, rkey)
  local existing = db.get("at://" .. our_did .. "/" .. RELEASE_STATE .. "/" .. rkey)
  return existing and existing.record or nil
end

--- Fetches one artifact, checks it against its declared checksum, and stores
--- it. Answers `{cid, mimeType}`. Raises with a reason, so a caller can
--- decide whether that reason is fatal.
local function copy_one(publisher, artifact)
  local declared = sha256_digest_hex(artifact.checksum)
  if not declared then
    error("checksum is not a multibase sha2-256 multihash: " .. tostring(artifact.checksum))
  end

  -- A blob is preferred over a url: it sits in the publisher's own repo, which
  -- is the copy their record signed over.
  local bytes, mime
  local blob_cid = ((artifact.blob or {}).ref or {})["$link"]
  if blob_cid then
    local downloaded = atproto.blob_download(publisher, blob_cid)
    bytes, mime = downloaded.bytes, downloaded.mime_type
  elseif type(artifact.url) == "string" and artifact.url ~= "" then
    local response = http.get(artifact.url)
    if response.status < 200 or response.status >= 300 then
      error("url answered " .. tostring(response.status))
    end
    bytes = response.body
    mime = artifact.contentType
  else
    error("carries neither a blob nor a url")
  end

  mime = mime or artifact.contentType or "application/octet-stream"
  local cid = blobs.put(bytes, mime)
  local stored = sha256_digest_hex(cid)
  if stored ~= declared then
    -- The bytes stay: they are addressed by their own content, so wrong bytes
    -- cannot occupy the right CID. The release simply never becomes servable,
    -- which is the whole point of checking.
    error("bytes do not match the declared checksum (declared " .. declared
      .. ", got " .. tostring(stored) .. ")")
  end
  -- The store's own count, not `#bytes`: bytes that are not valid UTF-8
  -- arrive as `{ ["$bytes"] = "<base64>" }`, whose length is not theirs.
  local info = blobs.stat(cid)
  return { cid = cid, mimeType = mime, size = info and info.size }
end

local function fail(message)
  -- A job's error is what an operator reads, so it says what to do about it.
  error(message)
end

function handle(input, ctx)
  local our_did = (ctx.env or {}).HAPPYPROTO_DID
  if type(our_did) ~= "string" or our_did == "" then
    fail("HAPPYPROTO_DID is unset, so the release's state row cannot be written")
  end

  local rkey = input.stateRkey
  local fields = state_fields(our_did, rkey)
  if not fields then
    fail("no state row at " .. tostring(rkey) .. "; the indexer should have written one")
  end
  if fields.status == "deleted" then
    log.info("registry: release withdrawn before its artifact was copied", { rkey = rkey })
    return { skipped = "withdrawn" }
  end
  if fields.status == "active" then
    -- A retried job, or a replayed enqueue. The bytes are already held.
    return { skipped = "already copied", held = fields.held }
  end

  local release = db.get(input.uri)
  if not release then
    fail("the release record at " .. tostring(input.uri) .. " is no longer indexed")
  end
  local artifacts = (release.record or {}).artifacts or {}

  -- Every key whose value is an artifact object. That is `package`, `icon`,
  -- `banner` and any `x-` custom type, and it naturally skips `screenshots`,
  -- whose value is an array rather than an artifact -- those are not copied
  -- yet, and getArtifact answers ArtifactNotHeld for them.
  local held = fields.held or {}
  local problems = {}
  for kind, artifact in pairs(artifacts) do
    if type(artifact) == "table" and artifact.checksum ~= nil and not held[kind] then
      local ok, result = pcall(copy_one, input.did, artifact)
      if ok then
        held[kind] = result
      elseif kind == "package" then
        -- The module is the release. Without it there is nothing to serve, so
        -- the job fails and can be retried.
        fail("could not copy the package artifact: " .. tostring(result))
      else
        -- A presentation asset must never keep a working module out of the
        -- index, so its failure is recorded and the job carries on.
        problems[#problems + 1] = kind .. ": " .. tostring(result)
      end
    end
  end

  if not held.package then
    fail("the release declares no package artifact")
  end

  fields.status = "active"
  fields.held = held
  record.save_local(RELEASE_STATE, rkey, fields, our_did)

  log.info("registry: artifacts copied", {
    did = input.did, slug = input.slug, version = input.version,
    package_cid = held.package.cid, skipped = #problems,
  })
  if #problems > 0 then
    log.warn("registry: some presentation assets were not copied", { problems = problems })
  end
  return { package = held.package, skipped = problems }
end
