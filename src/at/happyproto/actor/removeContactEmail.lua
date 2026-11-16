-- at.happyproto.actor.removeContactEmail
--
-- Remove the caller's contact email (HAP-463): their preferences space keeps
-- a contact record with no address, so sign-in never writes one back from
-- the PDS, and the provisioner forgets every address proven for them and
-- every link still open. The address on their PDS account is untouched, and
-- HappyProto still checks account requests against it.
--
-- Customers and staff only, either gate admitting; each fails closed.

-- @prelude gate, validate, provisioner, preferences

function handle(input, ctx)
  if not ctx.caller_did or ctx.caller_did == "" then
    return failure("AuthRequired", "This endpoint requires an authenticated caller.")
  end
  if not is_uuid(input.idempotencyKey) then
    return failure("InvalidRequest", "idempotencyKey must be a UUID.")
  end
  if gate_customer(ctx) ~= nil and gate_admin(ctx) ~= nil then
    return failure("Forbidden", "Only customers and staff have contact settings.")
  end

  local uri = preferences.space(ctx, true)
  if not uri then return failure("Upstream", "Your preferences could not be saved.") end
  if not preferences.write(uri, preferences.CONTACT, { source = "owner" }) then
    return failure("Upstream", "Your preferences could not be saved.")
  end
  local status, body = provisioner(ctx, "DELETE", "/v1/account/email-proofs", nil, input.idempotencyKey)
  if status ~= 200 then
    return contact_failure(status, body)
  end
  return { removed = true }
end
