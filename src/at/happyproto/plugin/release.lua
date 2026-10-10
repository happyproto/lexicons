-- @prelude plugin, authority
--
-- record.index:at.happyproto.plugin.release
--
-- Indexes one version of a package, and enqueues the artifact copy that makes
-- it servable. The publisher's record is indexed verbatim (`true`, not a
-- table); everything the registry derives lives in a state row of ours.
--
-- A release is only LISTED once its bytes are held, which is the registry's
-- first obligation. That is enforced by construction rather than by
-- remembering to check: the state row starts `pending` here, and only the
-- copy job moves it to `active`.
--
-- The copy is a job, not part of this handler, for two reasons. A record event
-- runs under the instruction budget and a job runs under none, and decoding a
-- megabyte of artifact into Lua values would spend that budget. And a
-- publisher's unreachable URL should fail a retryable job, not dead-letter a
-- firehose event that was itself perfectly valid.
--
-- Version immutability needs no CID comparison, which is just as well: the
-- record-event payload carries no CID. A release at a given version is never
-- modified, so an `update` event IS the violation, and the first record seen
-- stays. A second `create` is the ordinary replay of a rewound cursor and is
-- skipped quietly.

local log = require("internal.logging")
local db = require("happyview.db")
local record = require("happyview.record")
local jobs = require("happyview.jobs")

local COPY_JOB = "registry.copy-artifact"

local function state_uri(our_did, rkey)
  return "at://" .. our_did .. "/" .. RELEASE_STATE .. "/" .. rkey
end

function handle(input, ctx)
  local our_did = happyproto_did(ctx)
  if not our_did then
    error("HAPPYPROTO_DID is unset or malformed, so registry state cannot be written")
  end

  local publisher = input.did
  local slug, version = split_release_rkey(input.rkey)
  if not slug then
    log.info("registry: release rkey is not <slug>:<version>", {
      did = publisher, rkey = input.rkey,
    })
    return nil
  end

  local rkey = release_state_rkey(publisher, slug, version)
  local existing = db.get(state_uri(our_did, rkey))

  if input.action == "delete" then
    if existing then
      local fields = existing.record
      fields.status = "deleted"
      record.save_local(RELEASE_STATE, rkey, fields, our_did)
    else
      -- A delete for a version never indexed still earns a tombstone, or the
      -- version could be published afterwards and look new.
      record.save_local(RELEASE_STATE, rkey, {
        status = "deleted", did = publisher, slug = slug, version = version,
      }, our_did)
    end
    log.info("registry: release withdrawn", { did = publisher, slug = slug, version = version })
    -- Skip the delete, so the release stays served by exact version.
    return nil
  end

  if existing then
    local status = existing.record.status
    if status == "deleted" then
      -- A deleted version must not be republished: without this, deleting and
      -- re-creating a release would get around immutability entirely.
      log.warn("registry: refused a republish of a withdrawn version", {
        did = publisher, slug = slug, version = version,
      })
      return nil
    end
    if input.action == "update" then
      log.warn("registry: release was modified after publication; keeping the first", {
        did = publisher, slug = slug, version = version,
      })
      return nil
    end
    -- A repeated create is a replayed cursor. Already held; nothing to do.
    return nil
  end

  local problem = release_problem(input.record, slug, version)
  if problem then
    log.info("registry: release refused", {
      did = publisher, slug = slug, version = version, reason = problem,
    })
    return nil
  end

  record.save_local(RELEASE_STATE, rkey, {
    status = "pending",
    did = publisher,
    slug = slug,
    version = version,
    uri = input.uri,
  }, our_did)

  jobs.create(COPY_JOB, {
    did = publisher,
    slug = slug,
    version = version,
    uri = input.uri,
    stateRkey = rkey,
  })

  return true
end
