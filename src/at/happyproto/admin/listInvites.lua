-- at.happyproto.admin.listInvites
--
-- Every customer invite the provisioner has recorded, newest first: the
-- address, its state, and the account that redeemed it. Staff only.

-- @prelude gate, provisioner, json

--- A provisioner refusal of an invites route, as this endpoint's errors.
--- Only Forbidden (the caller is not in STAFF_DIDS) and an in-flight retry
--- mean anything to the caller; every other reply is Upstream, logged.
local function invites_failure(status, body)
  local code = type(body) == "table" and body.error or nil
  if status == 403 then
    return failure("Forbidden", "Only staff the provisioner knows can manage invites.")
  end
  log.warn("provisioner refused an invites request", { status = status, body = body })
  return failure("Upstream", "The provisioner could not complete the request.")
end

function handle(input, ctx)
  local refused = gate_admin(ctx)
  if refused then return refused end

  local status, body = provisioner(ctx, "GET", "/v1/invites")
  if status ~= 200 or type(body) ~= "table" or type(body.invites) ~= "table" then
    return invites_failure(status, body)
  end

  local invites = {}
  for _, i in ipairs(body.invites) do
    invites[#invites + 1] = {
      id = i.id,
      email = i.email,
      status = i.status,
      createdBy = i.created_by,
      createdAt = i.created_at,
      expiresAt = i.expires_at,
      redeemedDid = type(i.redeemed_did) == "string" and i.redeemed_did or nil,
      redeemedAt = type(i.redeemed_at) == "string" and i.redeemed_at or nil,
    }
  end
  return { invites = json.to_array(invites) }
end
