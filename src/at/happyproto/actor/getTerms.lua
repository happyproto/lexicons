-- at.happyproto.actor.getTerms
--
-- Has the caller accepted the beta terms in force (HAP-299)? The dashboard
-- asks after each sign-in and shows the terms until they have: once per
-- account, and again whenever the terms change. The provisioner holds the
-- answer, and refuses a create by anyone who hasn't accepted, staff included,
-- so this only decides what the dashboard shows.
--
-- Customers and staff only, either gate admitting; each fails closed. Anyone
-- else has no HappyProto account to have accepted anything.

-- @prelude gate, provisioner

function handle(input, ctx)
  if not ctx.caller_did or ctx.caller_did == "" then
    return failure("AuthRequired", "This endpoint requires an authenticated caller.")
  end
  if gate_customer(ctx) ~= nil and gate_admin(ctx) ~= nil then
    return failure("Forbidden", "Only customers and staff accept the beta terms.")
  end

  local status, body = provisioner(ctx, "GET", "/v1/account")
  if status ~= 200 or type(body) ~= "table"
    or type(body.terms_version) ~= "string" or type(body.terms_accepted) ~= "boolean" then
    return provisioner_failure(status, body)
  end
  -- Whether the account has signed up in the open beta, so the dashboard
  -- words a later terms change as accepting, not joining.
  local result = {
    termsVersion = body.terms_version,
    accepted = body.terms_accepted,
    signedUp = body.signed_up == true,
  }
  -- During a terms change, an account still on the previous terms is told
  -- what comes next and when (TERMS_PREVIOUS_UNTIL), so the dashboard shows
  -- a notice instead of the terms screen. Passed on only when well formed.
  local upcoming = body.terms_upcoming
  if type(upcoming) == "table" and type(upcoming.terms_version) == "string"
    and type(upcoming.effective_at) == "string" then
    result.upcoming = {
      termsVersion = upcoming.terms_version,
      effectiveAt = upcoming.effective_at,
    }
  end
  return result
end
