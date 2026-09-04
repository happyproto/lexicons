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

local SPACE_URI = env.HAPPYPROTO_ADMIN_SPACE

--- Public basics for any actor. This is the DEFAULT projection: every caller
--- gets exactly this, and the entitlement fields are added afterwards only
--- when the actor is provably the caller. Written this way round so a later
--- edit cannot widen disclosure by forgetting a guard.
local function basics(identifier)
  local response = xrpc.query("app.bsky.actor.getProfile", { actor = identifier })
  if response.status ~= 200 or not response.body or not response.body.did then
    return nil
  end
  local profile = response.body
  return {
    did = profile.did,
    handle = profile.handle,
    displayName = profile.displayName,
    avatar = profile.avatar,
  }
end

-- Expected conditions are returned, never raised. Lua's `error()` produces a
-- 500 with a stack traceback — the wrong status for "you are not signed in",
-- and it puts internal file paths in front of the caller.
local function failure(name, message)
  return { error = name, message = message }
end

function handle()
  if not caller_did or caller_did == "" then
    return failure("AuthRequired", "This endpoint requires an authenticated caller.")
  end

  -- `actor` may be a handle or a DID. Resolving through getProfile accepts
  -- either and hands back the canonical DID, which is what the space lookup
  -- needs — so there is no separate handle-resolution step to get wrong.
  local requested = params.actor
  local identifier = requested
  if not identifier or identifier == "" then
    identifier = caller_did
  end

  local profile = basics(identifier)
  if not profile then
    -- Falling back to the bare DID for the caller keeps sign-in working even
    -- if the profile lookup is unavailable: entitlements do not depend on it.
    if identifier == caller_did then
      profile = { did = caller_did }
    else
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

  if not SPACE_URI or SPACE_URI == "" then
    -- Fail closed. With no space configured there is nothing to be a member
    -- of, so nobody is one — treating unconfigured as "allow" would turn a
    -- missing script variable into an open door.
    profile.isMember = false
    return profile
  end

  local access = atproto.spaces.get_access(SPACE_URI, caller_did)
  profile.access = access
  profile.isMember = access ~= nil
  return profile
end
