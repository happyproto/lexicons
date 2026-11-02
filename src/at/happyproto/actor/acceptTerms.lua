-- at.happyproto.actor.acceptTerms
--
-- Record that the caller accepted the beta terms in force (HAP-299), with the
-- exact wording they were shown. The dashboard calls it from the screen it
-- shows after sign-in until getTerms says they have. The provisioner keeps
-- each acceptance, append-only, against the caller's DID, and records nothing
-- new for terms already accepted. It also checks the version and the wording,
-- so here they are only shape-checked.
--
-- Customers and staff only, either gate admitting; each fails closed.

-- @prelude gate, validate, provisioner

function handle(input, ctx)
  if not ctx.caller_did or ctx.caller_did == "" then
    return failure("AuthRequired", "This endpoint requires an authenticated caller.")
  end
  if not is_uuid(input.idempotencyKey) then
    return failure("InvalidRequest", "idempotencyKey must be a UUID.")
  end
  if type(input.termsVersion) ~= "string" or type(input.textVersion) ~= "string"
    or type(input.text) ~= "string" then
    return failure("InvalidRequest", "termsVersion, textVersion and text are required.")
  end
  if gate_customer(ctx) ~= nil and gate_admin(ctx) ~= nil then
    return failure("Forbidden", "Only customers and staff accept the beta terms.")
  end

  local status, body = provisioner(ctx, "POST", "/v1/account/terms", {
    terms_version = input.termsVersion,
    text_version = input.textVersion,
    text = input.text,
  }, input.idempotencyKey)
  if status == 400 and type(body) == "table" and type(body.message) == "string" then
    if body.error == "TermsRequired" then return failure("TermsRequired", body.message) end
    if body.error == "TermsOutdated" then return failure("TermsOutdated", body.message) end
  end
  if status ~= 200 or type(body) ~= "table" or type(body.terms_version) ~= "string" then
    return provisioner_failure(status, body)
  end
  return { termsVersion = body.terms_version, accepted = body.terms_accepted == true }
end
