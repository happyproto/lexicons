-- @prelude release, authority
--
-- record.index:at.happyproto.registry.project
--
-- Indexes the sidecar that makes a software.release project a HappyView
-- plugin. Every other release record is judged against a stored sidecar, so
-- this one is judged on its own: the gateway writes it before the project, and
-- waiting for the project here would leave the project with nothing to be
-- judged against.
--
-- The sidecar pins its publication by CID, so a new sidecar is the only event
-- that says the publication changed. Each create or update re-reads it in a
-- job: a publication is not indexed, and fetching it here would spend a record
-- event's budget on another repo's network round trip.

local log = require("internal.logging")
local jobs = require("happyview.jobs")

function handle(input, ctx)
  if not happyproto_did(ctx) then
    -- Raised so the event retries and then dead-letters visibly, rather than
    -- indexing a plugin whose publication could never be cached.
    error("HAPPYPROTO_DID is unset or malformed, so registry state cannot be written")
  end

  -- A deleted sidecar keeps its row, so the project's releases stay readable.
  if input.action == "delete" then return nil end

  local did, name = input.did, input.rkey
  local problem = sidecar_problem(input.record, did, name)
  if problem then
    log.info("registry: sidecar refused", { did = did, name = name, reason = problem })
    return nil
  end

  local publication = input.record.publication
  jobs.create("registry.fetch-publication", {
    did = did, name = name, uri = publication.uri, cid = publication.cid,
  })
  return true
end
