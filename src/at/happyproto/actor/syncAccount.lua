-- at.happyproto.actor.syncAccount
--
-- Record the email address on the caller's PDS account with HappyProto. The
-- dashboard calls it once after each sign-in. The address verifies
-- account-closure and waitlist requests (infrastructure docs/accounts.md), so
-- it has to come from the caller's own PDS, read server-side through their
-- session, never from anything the client says.
--
-- The PDS reports it only when the session was granted transition:email, and
-- may have none at all. Neither is an error: the provisioner is told there was
-- no address and keeps the last one it recorded. A HappyView or xrpc library
-- too old to read the session is the same "no address".
--
-- Customers and staff only: anyone else has no HappyProto account to record
-- it against, and gets recorded = false rather than an error, since the
-- dashboard calls this for everyone who signs in.

-- @prelude gate, validate, provisioner

local xrpc = require("happyview.xrpc")

--- The caller's address and whether the PDS says it is confirmed, or nil.
--- `xrpc.session` RAISES on any failure, and is absent from an older library,
--- so it is called under pcall and any failure reads as "no address".
local function pds_email(ctx)
  local ok, account = pcall(function() return xrpc.session() end)
  if not ok then
    log.info("could not read the caller's PDS session", { error = tostring(account) })
    return nil, nil
  end
  -- The host already refuses a session naming another account; checked again
  -- here because this address is what an account closure is verified against.
  if type(account) ~= "table" or account.did ~= ctx.caller_did then
    log.warn("the PDS session named another account", {})
    return nil, nil
  end
  local email = account.email
  if type(email) ~= "string" or email == "" then
    return nil, nil
  end
  local confirmed = account.email_confirmed
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

  local email, confirmed = pds_email(ctx)
  -- A blank address is the provisioner's "none this time": an empty table
  -- could encode as a JSON array, and there is no null to send.
  local status, body = provisioner(ctx, "PUT", "/v1/account/email", {
    email = email or "",
    email_confirmed = confirmed,
  }, input.idempotencyKey)
  if status ~= 200 or type(body) ~= "table" then
    return provisioner_failure(status, body)
  end

  local out = { recorded = true }
  if type(body.email) == "string" and body.email ~= "" then
    out.email = body.email
    if type(body.email_confirmed) == "boolean" then
      out.emailConfirmed = body.email_confirmed
    end
  end
  return out
end
