-- at.happyproto.actor.getContact
--
-- The caller's contact email and notice settings, from their preferences
-- space (HAP-463), for the dashboard's Account screen. The address is the
-- caller's own, so it is returned to them, and only to them: the space is
-- read for the caller, never for a DID the client names.
--
-- `verified` and `pendingVerified` say whether each address is proven to be
-- the caller's, which only an opened link does. A pending address
-- whose link was opened is reported as verified here and promoted by the
-- next write or sign-in; a query writes nothing.
--
-- Customers and staff only, either gate admitting; each fails closed.

-- @prelude gate, validate, provisioner, preferences

function handle(input, ctx)
  if not ctx.caller_did or ctx.caller_did == "" then
    return failure("AuthRequired", "This endpoint requires an authenticated caller.")
  end
  if gate_customer(ctx) ~= nil and gate_admin(ctx) ~= nil then
    return failure("Forbidden", "Only customers and staff have contact settings.")
  end

  local status, account = provisioner(ctx, "GET", "/v1/account")
  if status ~= 200 or type(account) ~= "table" then
    return provisioner_failure(status, account)
  end
  -- Whether owner contact email is switched on at all: the dashboard asks
  -- for an address only when it is.
  local out = { enabled = account.contact_email == true, verified = false, maintenance = true }
  local uri, why = preferences.space(ctx, false, account)
  if not uri then
    if why then return failure("Upstream", "Your preferences could not be read.") end
    return out
  end
  local contact = preferences.read(ctx, uri, preferences.CONTACT)
  local notices = preferences.read(ctx, uri, preferences.NOTICES)
  if contact == nil or notices == nil then
    return failure("Upstream", "Your preferences could not be read.")
  end
  if notices and notices.maintenance == false then out.maintenance = false end
  if not contact then return out end

  local email = preferences.is_email(contact.email) and contact.email or nil
  local pending = preferences.is_email(contact.pendingEmail) and contact.pendingEmail or nil
  local proofs, refused = preferences.proven(ctx, email, pending)
  if not proofs then return refused end
  out.email = email
  out.verified = email ~= nil and proofs[email] == true
  if pending then
    out.pendingEmail = pending
    out.pendingVerified = proofs[pending] == true
  end
  return out
end
