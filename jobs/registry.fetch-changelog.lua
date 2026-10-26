-- @prelude release, authority
--
-- job.run:registry.fetch-changelog
--
-- Caches a version's changelog, a site.standard.document in the publisher's
-- repo, as CHANGELOG_CACHE `<did>:<name>:<version>`. Enqueued by
-- record.index:software.release.version with `{ did, name, version, uri }`.
--
-- This is the first fill only. The registry does not index site.standard
-- records, so the reads refresh a stale copy themselves, through the same
-- fetch_changelog.

local log = require("internal.logging")

function handle(input, ctx)
  local our_did = happyproto_did(ctx)
  if not our_did then
    error("HAPPYPROTO_DID is unset or malformed, so the changelog cannot be cached")
  end

  local did, name, version, uri = input.did, input.name, input.version, input.uri
  local cache, problem, retryable = fetch_changelog(our_did, did, name, version, uri)
  if cache then return { uri = cache.uri } end
  if retryable then
    -- Raised, so the job is retried: the publisher's PDS may be down.
    error("could not fetch " .. tostring(uri) .. ": " .. tostring(problem))
  end
  -- Nothing a retry could change: a document that is not this project's, or
  -- a PDS that does not resolve. A later record event queues a fresh fetch.
  log.warn("registry: changelog not cached", { did = did, uri = uri, problem = problem })
  return { skipped = problem }
end
