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
  return { termsVersion = body.terms_version, accepted = body.terms_accepted }
end
