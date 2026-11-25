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
--
-- Then the account's preferences space (HAP-463): created if it does not
-- exist yet, its contact record written from this address the first time
-- there is one (and never again: after that only the owner changes it), and a
-- change whose link was opened promoted. That part is best-effort and changes
-- nothing in the reply: a sign-in never fails on it, and the next one tries
-- again.

-- @prelude gate, validate, provisioner, preferences

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

  local email, confirmed = preferences.pds_email()
  -- A blank address is the provisioner's "none this time": an empty table
  -- could encode as a JSON array, and there is no null to send.
  local status, body = provisioner(ctx, "PUT", "/v1/account/email", {
    email = email or "",
    email_confirmed = confirmed,
  }, input.idempotencyKey)
  if status ~= 200 or type(body) ~= "table" then
    return provisioner_failure(status, body)
  end

  local synced, err = pcall(preferences.sync, ctx, email)
  if not synced then
    log.warn("preferences not synced", { error = tostring(err) })
  end

  -- The provisioner never sends the address back, and neither does this: an
  -- answer may be logged or cached, and nothing in the dashboard needs it.
  local out = { recorded = true, emailRecorded = body.email_recorded == true }
  if out.emailRecorded and type(body.email_confirmed) == "boolean" then
    out.emailConfirmed = body.email_confirmed
  end
  return out
end
