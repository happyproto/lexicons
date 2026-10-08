-- at.happyproto.actor.getProfile
--
-- Who is this, and — for the caller only — may they use the dashboard?
--
-- Access is membership of the HappyProto admin space, so granting or revoking
-- a customer is adding or removing a space member. There is no separate
-- customer list to drift out of sync with.
--
-- The space uri is a script variable rather than a literal because it embeds
-- the authority DID, and the whole uri is what makes the check meaningful:
-- matching on the space TYPE alone would admit everyone, since any user can
-- create a space of any type and is auto-added to their own as a write member.

-- @prelude failure, json

local xrpc = require("happyview.xrpc")
local spaces = require("happyview.spaces")

local MEMBER_ACCESS = { read = true, read_self = true, write = true }

--- Public basics for any actor. This is the DEFAULT projection: every caller
--- gets exactly this, and the entitlement fields are added afterwards only
--- when the actor is provably the caller. Written this way round so a later
--- edit cannot widen disclosure by forgetting a guard.
---
--- Returns nil rather than raising. `xrpc.query` RAISES on any failure — it
--- does not hand back a status — so a bare call here kills the whole script.
--- And it will fail routinely: `app.bsky.actor.getProfile` is not served locally, it
--- is proxied to the actor's PDS, which answers 401 because the proxy carries
--- no credentials. Profile decoration is therefore best-effort by nature, and
--- entitlements must never depend on it.
local function basics(identifier)
  local ok, profile = pcall(xrpc.query, "app.bsky.actor.getProfile", { actor = identifier })
  if not ok then return nil end
  if type(profile) ~= "table" or not profile.did then return nil end
  return {
    did = profile.did,
    handle = profile.handle,
    displayName = profile.displayName,
    avatar = profile.avatar,
  }
end

function handle(input, ctx)
  local caller_did = ctx.caller_did
  if not caller_did or caller_did == "" then
    return failure("AuthRequired", "This endpoint requires an authenticated caller.")
  end

  -- `actor` may be a handle or a DID. Resolving through getProfile accepts
  -- either and hands back the canonical DID, which is what the space lookup
  -- needs — so there is no separate handle-resolution step to get wrong.
  local requested = input.actor
  local identifier = requested
  if not identifier or identifier == "" then
    identifier = caller_did
  end

  local profile = basics(identifier)
  if not profile then
    if identifier == caller_did then
      -- The caller is known from the token; decoration is optional. Sign-in
      -- must not depend on a third-party profile lookup succeeding.
      profile = { did = caller_did }
    else
      -- For another actor there is nothing left to return. Resolving a handle
      -- without PDS credentials needs a different path (DID document, or a
      -- public AppView) — not built, because nothing needs it yet.
      return failure("ActorNotFound", "Could not resolve " .. tostring(identifier) .. ".")
    end
  end

  -- Compare resolved DIDs, never the raw parameter. Someone asking for their
  -- own handle rather than their DID is still asking about themselves, and a
  -- string comparison on the input would call that a different actor.
  local is_self = profile.did == caller_did
  profile.isSelf = is_self

  if not is_self then
    -- Deliberately nothing further. Entitlements are the caller's business
    -- alone; this branch exists so other actors can be rendered in an ACL
    -- list without that list becoming a way to enumerate who has access.
    return profile
  end

  local space_uri = ctx.env.HAPPYPROTO_ADMIN_SPACE
  if not space_uri or space_uri == "" then
    -- Fail closed. With no space configured there is nothing to be a member
    -- of, so nobody is one — treating unconfigured as "allow" would turn a
    -- missing script variable into an open door.
    profile.isMember = false
    return profile
  end

  -- pcall for the same reason as the fleet scripts: a raise here would turn a
  -- feature-flag problem into a 500 and make sign-in impossible to diagnose.
  local ok, access = pcall(function()
    return spaces.get(space_uri):access(caller_did)
  end)
  if not ok then
    profile.isMember = false
    return profile
  end
  -- Same allowlist as the gate, so this reports exactly what the gate would
  -- decide. A non-member gets no `access` field at all.
  profile.isMember = MEMBER_ACCESS[access] == true
  if profile.isMember then profile.access = access end
  return profile
end
