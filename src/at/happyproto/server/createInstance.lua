-- at.happyproto.server.createInstance
--
-- Create an instance for the caller, and start the job that follows its
-- provisioning. Customers only.
--
-- The instance is always the caller's own: owner_did is ctx.caller_did, never
-- an input. The idempotencyKey travels as Idempotency-Key, so a double-click
-- or a network retry gets the first reply back -- the same instance and the
-- same operation -- instead of a second tenant or SlugTaken.

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

  local status, body = provisioner(ctx, "POST", "/v1/tenants", {
    owner_did = ctx.caller_did,
    slug = input.slug,
    plan = input.plan,
  }, input.idempotencyKey)
  if status ~= 201 or type(body) ~= "table" or type(body.tenant) ~= "table" then
    return provisioner_failure(status, body)
  end

  local job_id, failed = follow_operation(body.operation)
  if not job_id then return failed end
  return { instance = public_instance(body.tenant, body.operation), jobId = job_id }
end
