-- @prelude release, authority
--
-- record.index:at.happyproto.registry.project
--
-- Indexes the sidecar that makes a software.release project a HappyView
-- plugin. Every other release record is judged against a live sidecar, so
-- this one is judged on its own: the gateway writes it before the project, and
-- waiting for the project here would leave the project with nothing to be
-- judged against.
--
-- The sidecar pins its publication by CID, so a new sidecar is the only event
-- that says the publication changed. Each new one re-reads it in a job: a
-- publication is not indexed, and fetching it here would spend a record
-- event's budget on another repo's network round trip.
--
-- A delete keeps the row, because versions already indexed stay served and
-- their views read it, and marks the project's state so it takes no new
-- releases. Writing the sidecar again clears the mark.
--
-- Every other record is indexed only while a live sidecar exists, and one
-- that arrived without one was skipped for good. So a sidecar that arrives,
-- or comes back, after the project's records queues
-- registry.backfill-project, which reads them from the publisher's PDS and
-- stores those the indexers would have taken. A replay or an edit of a live
-- sidecar queues none: nothing was skipped meanwhile.

local log = require("internal.logging")
local db = require("happyview.db")
local jobs = require("happyview.jobs")

function handle(input, ctx)
  local our_did = happyproto_did(ctx)
  if not our_did then
    -- Raised so the event retries and then dead-letters visibly, rather than
    -- indexing a plugin whose publication could never be cached.
    error("HAPPYPROTO_DID is unset or malformed, so registry state cannot be written")
  end

  local did, name, r = input.did, input.rkey, input.record

  if input.action == "delete" then
    -- Only a sidecar the registry stored has a project to withdraw; marking
    -- any other would write state for a project that was never indexed.
    if is_project_name(name) and db.get(input.uri) then
      local state = project_state(our_did, did, name) or {}
      state.sidecarDeleted = true
      save_project_state(our_did, did, name, state)
      log.info("registry: sidecar deleted; the project takes no new releases", { did = did, name = name })
    end
    return nil
  end

  local problem = sidecar_problem(r, did, name)
  if problem then
    log.info("registry: sidecar refused", { did = did, name = name, reason = problem })
    return nil
  end

  local stored = prior_row(input.uri, input.record)
  -- Every manifest was checked against the sidecar's type when indexed, so a
  -- new type would leave them all of the wrong one.
  if stored and (stored.record or {}).pluginType ~= r.pluginType then
    log.warn("registry: sidecar changed its plugin type; keeping the first", { did = did, name = name })
    return nil
  end

  local state = project_state(our_did, did, name)
  local revived = state and state.sidecarDeleted
  -- A replayed cursor: the publication it pins is already being fetched.
  if stored and not revived and same_value(stored.record, r) then return nil end

  if revived then
    state.sidecarDeleted = nil
    save_project_state(our_did, did, name, state)
  end

  jobs.create("registry.fetch-publication", {
    did = did, name = name, uri = r.publication.uri, cid = r.publication.cid,
  })
  if not stored or revived then
    jobs.create("registry.backfill-project", { did = did, name = name })
  end
  return true
end
