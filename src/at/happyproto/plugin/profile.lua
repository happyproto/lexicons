-- @prelude plugin, authority
--
-- record.index:at.happyproto.plugin.profile
--
-- Indexes a plugin package as its publisher writes it, and keeps a state row
-- of our own beside it. The publisher's record is indexed verbatim -- the
-- handler returns `true` rather than a table -- so `packageView.record` can be
-- emitted as published, and nothing derived is mixed into it.
--
-- Deleting a profile withdraws the package. The delete event is SKIPPED so the
-- row survives, because releases under a withdrawn package stay resolvable by
-- exact version; the state row is what records that it is gone, and
-- searchPackages reads that.

local log = require("internal.logging")
local db = require("happyview.db")
local record = require("happyview.record")

local function state_uri(our_did, publisher, slug)
  return "at://" .. our_did .. "/" .. PACKAGE_STATE .. "/" .. publisher .. ":" .. slug
end

local function put_state(our_did, publisher, slug, fields)
  record.save_local(PACKAGE_STATE, publisher .. ":" .. slug, fields, our_did)
end

function handle(input, ctx)
  local our_did = happyproto_did(ctx)
  if not our_did then
    -- Fail loudly rather than index records whose state can never be written:
    -- a record event retries and then dead-letters, which is visible, where
    -- indexing without state would leave releases silently unlistable.
    error("HAPPYPROTO_DID is unset or malformed, so registry state cannot be written")
  end

  local publisher, slug = input.did, input.rkey
  if not is_plugin_slug(slug) then
    log.info("registry: profile rkey is not a slug", { did = publisher, rkey = slug })
    return nil
  end

  if input.action == "delete" then
    local existing = db.get(state_uri(our_did, publisher, slug))
    if existing then
      local fields = existing.record
      fields.status = "deleted"
      put_state(our_did, publisher, slug, fields)
    end
    log.info("registry: package withdrawn", { did = publisher, slug = slug })
    -- Skip, so the indexed profile stays readable for its releases.
    return nil
  end

  local problem = profile_problem(input.record, slug)
  if problem then
    log.info("registry: profile refused", {
      did = publisher, slug = slug, reason = problem,
    })
    return nil
  end
  local body = input.record

  put_state(our_did, publisher, slug, {
    status = "active",
    did = publisher,
    slug = slug,
    uri = input.uri,
  })

  return true
end
