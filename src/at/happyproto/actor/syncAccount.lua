-- at.happyproto.actor.syncAccount
--
-- Record the email address on the caller's PDS account with HappyProto. The
-- dashboard calls it once after each sign-in. The address verifies
-- account-closure and waitlist requests (infrastructure docs/accounts.md), so
-- it has to come from the caller's own PDS, read server-side through their
-- session, never from anything the client says.
--
-- It is read with happyview.account's email(), behind HappyView's caller:email
-- capability, so installing that library is api.happyproto.at's consent to
-- reading addresses. The host reads only the caller's own getSession, refuses
-- one naming another account, and refuses a service-auth caller.
--
-- The PDS reports it only when the sign-in granted it (transition:email or
-- account:email), and may have none at all. Neither is an error: the
-- provisioner is told there was no address and keeps the last one it
-- recorded. A missing happyview.account library, or a HappyView too old to
-- serve it, is the same "no address".
--
-- Customers and staff only: anyone else has no HappyProto account to record
-- it against, and gets recorded = false rather than an error, since the
-- dashboard calls this for everyone who signs in.

-- @prelude gate, validate, provisioner

--- The caller's address and whether the PDS says it is confirmed, or nil.
--- `require` raises when the library isn't installed, and `email` raises on
--- any failure, so both run under pcall and any failure reads as "no address".
local function pds_email()
  local ok, address = pcall(function() return require("happyview.account").email() end)
  if not ok then
    log.info("could not read the caller's PDS email", { error = tostring(address) })
    return nil, nil
  end
  if type(address) ~= "table" then
    return nil, nil
  end
  local email = address.email
  if type(email) ~= "string" or email == "" then
    return nil, nil
  end
  local confirmed = address.email_confirmed
  if type(confirmed) ~= "boolean" then confirmed = nil end
  return email, confirmed
end

function handle(input, ctx)
  if not ctx.caller_did or ctx.caller_did == "" then
    return failure("AuthRequired", "This endpoint requires an authenticated caller.")
  end
  if not is_uuid(input.idempotencyKey) then
    return failure("InvalidRequest", "idempotencyKey must be a UUID.")
  end
  -- Either gate admits; each fails closed.
  if gate_customer(ctx) ~= nil and gate_admin(ctx) ~= nil then
    return { recorded = false }
  end

  local email, confirmed = pds_email()
  -- A blank address is the provisioner's "none this time": an empty table
  -- could encode as a JSON array, and there is no null to send.
  local status, body = provisioner(ctx, "PUT", "/v1/account/email", {
    email = email or "",
    email_confirmed = confirmed,
  }, input.idempotencyKey)
  if status ~= 200 or type(body) ~= "table" then
    return provisioner_failure(status, body)
  end

  -- The provisioner never sends the address back, and neither does this: an
  -- answer may be logged or cached, and nothing in the dashboard needs it.
  local out = { recorded = true, emailRecorded = body.email_recorded == true }
  if out.emailRecorded and type(body.email_confirmed) == "boolean" then
    out.emailConfirmed = body.email_confirmed
  end
  return out
end
