-- at.happyproto.admin.createSignupInvite
--
-- Mint the standing signup invite for open signup (HAP-509): a customers-space
-- invite with read access, no use limit and no expiry. Staff only. The token
-- is answered once and kept nowhere here; staff put it in the
-- HAPPYPROTO_SIGNUP_INVITE script variable, where actor.signUp reads it while
-- HAPPYPROTO_SIGNUP is "open" (see the `signup` prelude block).
--
-- happyview.spaces runs the write as the caller, and HappyView lets only the
-- space's creator or a HappyView super user create its invites, the same
-- rule as admin.createInvites, so a staff member who is neither is refused,
-- and told why.

-- @prelude gate, json

function handle(input, ctx)
  local refused = gate_admin(ctx)
  if refused then return refused end

  local uri = happyproto_space(ctx, CUSTOMERS_SPACE_TYPE)
  if not uri then
    return failure("Upstream", "customers space not configured")
  end

  local ok, invite = pcall(function()
    return spaces.get(uri):create_invite({ access = "read" })
  end)
  if not ok or type(invite) ~= "table" or type(invite.token) ~= "string" then
    if tostring(invite):find("NOT_AUTHORIZED", 1, true) then
      return failure("Forbidden", "Only the customers space's creator or a HappyView super user can invite customers.")
    end
    return failure("Upstream", "The customers space could not make an invite.")
  end
  return { token = invite.token, inviteId = invite.invite_id }
end
