-- @prelude release, authority
--
-- job.run:registry.fetch-changelog
--
-- Caches a version's changelog, a site.standard.document in the publisher's
-- repo, as CHANGELOG_CACHE `<did>:<name>:<version>`. Enqueued by
-- record.index:software.release.version with `{ did, name, version, uri }`.
--
-- This is the first fill only. The registry does not index site.standard
-- records, so the reads refresh a stale copy themselves.

local log = require("internal.logging")
local record = require("happyview.record")

local MARKPUB = "at.markpub.markdown"

-- Far above what the gateway writes, but a document written some other way
-- could be any size, and the cache is served whole.
local MAX_TITLE_BYTES = 5000
local MAX_MARKDOWN_BYTES = 1048576

--- The document's markdown: markpub content when it carries it, else the
--- plain text every site.standard document has for exactly this purpose.
local function markdown_of(v)
  local content = v.content
  if type(content) == "table" and content["$type"] == MARKPUB
      and type(content.text) == "table" and type(content.text.markdown) == "string" then
    return content.text.markdown
  end
  if type(v.textContent) == "string" then return v.textContent end
  return nil
end

function handle(input, ctx)
  local our_did = happyproto_did(ctx)
  if not our_did then
    error("HAPPYPROTO_DID is unset or malformed, so the changelog cannot be cached")
  end

  local did, name, version, uri = input.did, input.name, input.version, input.uri
  local document_did, collection = parse_uri(uri)
  if document_did ~= did or collection ~= DOCUMENT then
    -- The indexer only queues documents in the publisher's own repo; this
    -- holds that even for a job queued some other way.
    log.warn("registry: changelog is not a document in the publisher's repo", { did = did, uri = uri })
    return { skipped = "not the publisher's document" }
  end

  local fetched, problem = pds_record(uri)
  if not fetched then
    -- Raised, so the job is retried: the publisher's PDS may be down.
    error("could not fetch " .. tostring(uri) .. ": " .. tostring(problem))
  end

  local v = fetched.value
  -- A document of this project's own publication, and no other: anyone's
  -- document could otherwise be presented as this release's notes.
  if v.site ~= uri_of(did, PUBLICATION, name) then
    log.warn("registry: changelog belongs to another publication", { uri = uri, site = v.site })
    return { skipped = "another publication" }
  end
  local markdown = markdown_of(v)
  if not markdown then
    log.warn("registry: changelog has no text", { uri = uri })
    return { skipped = "no text" }
  end

  if #markdown > MAX_MARKDOWN_BYTES then
    log.warn("registry: changelog is too long to cache", { uri = uri, bytes = #markdown })
    return { skipped = "too long" }
  end
  if type(v.title) == "string" and #v.title > MAX_TITLE_BYTES then
    log.warn("registry: changelog title is too long to cache", { uri = uri, bytes = #v.title })
    return { skipped = "title too long" }
  end

  local cache = {
    uri = uri,
    title = type(v.title) == "string" and v.title or nil,
    markdown = markdown,
    fetchedAt = now_iso(),
  }
  record.save_local(CHANGELOG_CACHE, version_state_rkey(did, name, version), cache, our_did)
  return { uri = uri }
end
