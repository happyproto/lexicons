-- at.happyproto.actor.confirmContactEmail
--
-- Prove the address a link was sent to (HAP-463), as the account it was sent
-- for: the dashboard's /verify-email page calls it with the token from the
-- link, once the visitor is signed in. A change waiting for this link becomes
-- the contact email. Opening the same link again answers the same.
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
  if type(input.token) ~= "string" or input.token == "" or #input.token > 128 then
    return failure("InvalidLink", "This link is not valid.")
  end
  if gate_customer(ctx) ~= nil and gate_admin(ctx) ~= nil then
    return failure("Forbidden", "Only customers and staff have contact settings.")
  end

  local status, body = provisioner(ctx, "POST", "/v1/account/contact-email/confirm",
    { token = input.token }, input.idempotencyKey)
  if status ~= 200 or type(body) ~= "table" or body.confirmed ~= true then
    return contact_failure(status, body)
  end

  -- The proof is kept whatever happens next; a promotion that fails here is
  -- done by the next write or sign-in.
  local uri = preferences.space(ctx, false)
  if uri then
    local contact = preferences.read(ctx, uri, preferences.CONTACT)
    if contact then preferences.promote(ctx, uri, contact) end
  end
  return { confirmed = true }
end
