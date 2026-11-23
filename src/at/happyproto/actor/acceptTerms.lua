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
--
-- While signup is open (the `signup` prelude block) the customer gate admits
-- anyone signed in, and for someone who isn't a member of the customers
-- space, nor staff, accepting the terms is signing up: it goes to the
-- provisioner's signup route, which may refuse (closed, suspended, or past
-- its breaker) and puts a new account in the open beta cohort.

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

  local signing_up = signup_open(ctx) and gate_admin(ctx) ~= nil and not in_customers_space(ctx)
  local status, body = provisioner(ctx, "POST", signing_up and "/v1/account/signup" or "/v1/account/terms", {
    terms_version = input.termsVersion,
    text_version = input.textVersion,
    text = input.text,
  }, input.idempotencyKey)
  local code = type(body) == "table" and body.error or nil
  if status == 400 and (code == "TermsRequired" or code == "TermsOutdated") then
    local fallback = code == "TermsRequired" and "Accept the beta terms first."
      or "The beta terms have changed; reload and accept the current ones."
    return failure(code, type(body.message) == "string" and body.message or fallback)
  end
  if signing_up then
    if status == 403 and code == "SignupsClosed" then
      return failure("SignupsClosed", "Signup is closed.")
    end
    if status == 403 and code == "AccountSuspended" then
      return failure("AccountSuspended", "This account is suspended.")
    end
    if status == 429 and code == "SignupsPaused" then
      return failure("SignupsPaused", "Signups are paused for now. Try again later.")
    end
  end
  if status ~= 200 or type(body) ~= "table" or type(body.terms_version) ~= "string" then
    return provisioner_failure(status, body)
  end
  return { termsVersion = body.terms_version, accepted = body.terms_accepted == true }
end
