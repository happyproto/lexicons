-- at.happyproto.actor.getTerms
--
-- Has the caller accepted the beta terms in force (HAP-299)? The dashboard
-- asks after each sign-in and shows the terms until they have: once per
-- account, and again whenever the terms change. The provisioner holds the
-- answer, and refuses a create by anyone who hasn't accepted, staff included,
-- so this only decides what the dashboard shows.
--
-- `notice` is set while the caller's account is on the previous terms in
-- their notice period (the provisioner's TERMS_PREVIOUS_*): they still count
-- as accepted, and the dashboard says when the terms in force take effect.
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
  local out = { termsVersion = body.terms_version, accepted = body.terms_accepted }
  local notice = body.terms_notice
  if type(notice) == "table" and type(notice.terms_version) == "string"
    and type(notice.takes_effect_at) == "string" then
    out.notice = { termsVersion = notice.terms_version, takesEffectAt = notice.takes_effect_at }
  end
  return out
end
