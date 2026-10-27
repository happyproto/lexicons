-- at.happyproto.actor.acceptInvite
--
-- Redeem an invite from admin.createInvites: the caller joins the customers
-- space, and the provisioner pairs the address the invite went to with the
-- caller's account. Not gated, since the caller is by definition not a
-- customer yet; the token is the authority, and HappyView checks its use
-- count, expiry and revocation itself.
--
-- An account that is already a customer is told so and spends nothing, so
-- opening the same invite link twice, or after a staff member has added the
-- account by hand, is not an error.
--
-- A token for some other space would join the caller to that space before
-- this script sees which space it was: accept_invite takes only the token.
-- The caller gains nothing here from that, and is told the invite is not one
-- of ours.

-- @prelude failure, validate, access, authority, provisioner, json

local spaces = require("happyview.spaces")

function handle(input, ctx)
  local caller = ctx.caller_did
  if not caller or caller == "" then
    return failure("AuthRequired", "This endpoint requires an authenticated caller.")
  end

  local token = input.token
  if type(token) ~= "string" or #token == 0 or #token > 128 or not token:match("^%x+$") then
    return failure("InvalidRequest", "token must be an invite token.")
  end
  if not is_uuid(input.idempotencyKey) then
    return failure("InvalidRequest", "idempotencyKey must be a UUID.")
  end

  local uri = happyproto_space(ctx, CUSTOMERS_SPACE_TYPE)
  if not uri then
    return failure("Upstream", "customers space not configured")
  end

  local ok, access = pcall(function()
    return spaces.get(uri):access(caller)
  end)
  if not ok then
    return failure("Upstream", "The customers space could not be read.")
  end
  if MEMBER_ACCESS[access] then
    return { isCustomer = true, joined = false }
  end

  local joined_ok, space = pcall(function()
    return spaces.accept_invite({ token = token })
  end)
  if not joined_ok then
    -- The error text carries HappyView's own message after the library's
    -- code; match the message, which names the reason.
    local err = tostring(space):lower()
    if err:find("expired", 1, true) then
      return failure("InviteExpired", "This invite has expired.")
    end
    if err:find("maximum uses", 1, true) or err:find("revoked", 1, true) then
      return failure("InviteUsed", "This invite has already been used.")
    end
    if err:find("already a member", 1, true) then
      return { isCustomer = true, joined = false }
    end
    if err:find("not_found", 1, true) or err:find("invalid invite", 1, true) then
      return failure("InvalidInvite", "This invite link is not valid.")
    end
    return failure("Upstream", "The invite could not be redeemed.")
  end

  if type(space) ~= "table" or space.uri ~= uri then
    return failure("InvalidInvite", "This invite link is not valid.")
  end

  -- The caller is a customer now, whatever the provisioner says: the address
  -- book is staff's record, not the caller's entitlement. A failure is
  -- logged, and the caller shows in the Customers list without an address.
  local status, body = provisioner(ctx, "POST", "/v1/invites/redeem", { token = token }, input.idempotencyKey)
  if status ~= 200 then
    log.warn("could not record an invite's redemption", { status = status, body = body, did = caller })
  end
  return { isCustomer = true, joined = true }
end
