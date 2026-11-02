-- at.happyproto.server.createInstance
--
-- Create an instance for the caller, and start the job that follows its
-- provisioning. Customers only.
--
-- The instance is always the caller's own: owner_did is ctx.caller_did, never
-- an input. The idempotencyKey travels as Idempotency-Key, so a double-click
-- or a network retry gets the first reply back -- the same instance and the
-- same operation -- instead of a second tenant or SlugTaken.
--
-- The caller accepts the beta terms (HAP-299) once, at sign-in, through
-- actor.acceptTerms. The provisioner refuses a create by anyone whose account
-- hasn't accepted the terms in force, staff included (TermsRequired, or
-- TermsOutdated for only older ones), so calling the API directly can't skip
-- it. terms is an acceptance made with this create instead, as dashboards from
-- before sign-in acceptance send; it is forwarded as given and only
-- shape-checked here.

-- @prelude gate, validate, provisioner, instance, jobs

function handle(input, ctx)
  local refused = gate_customer(ctx)
  if refused then return refused end

  if not is_uuid(input.idempotencyKey) then
    return failure("InvalidRequest", "idempotencyKey must be a UUID.")
  end
  if not is_slug(input.slug) then
    return failure("InvalidRequest", "slug must be 3 to 32 of a-z, 0-9 and -, start with a letter, and not be reserved.")
  end
  if type(input.plan) ~= "string" or input.plan == "" then
    return failure("InvalidRequest", "plan is required.")
  end
  local terms = nil
  if input.terms ~= nil then
    local t = input.terms
    if type(t) ~= "table" or type(t.termsVersion) ~= "string" or type(t.textVersion) ~= "string"
      or type(t.text) ~= "string" then
      return failure("InvalidRequest", "terms needs termsVersion, textVersion and text.")
    end
    terms = { terms_version = t.termsVersion, text_version = t.textVersion, text = t.text }
  end

  local status, body = provisioner(ctx, "POST", "/v1/tenants", {
    owner_did = ctx.caller_did,
    slug = input.slug,
    plan = input.plan,
    terms = terms,
  }, input.idempotencyKey)
  if status == 400 and type(body) == "table" and type(body.message) == "string" then
    if body.error == "TermsRequired" then return failure("TermsRequired", body.message) end
    if body.error == "TermsOutdated" then return failure("TermsOutdated", body.message) end
  end
  if status ~= 201 or type(body) ~= "table" or type(body.tenant) ~= "table" then
    return provisioner_failure(status, body)
  end

  local job_id, failed = follow_operation(body.operation)
  if not job_id then return failed end
  return { instance = public_instance(body.tenant, body.operation), jobId = job_id }
end
