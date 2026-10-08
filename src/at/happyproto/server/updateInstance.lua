-- at.happyproto.server.updateInstance
--
-- Move one of the caller's instances to another plan or HappyView release,
-- and start the job that follows the change. Customers only.
--
-- Ownership is checked here first, with owned_tenant, and not left to the
-- provisioner: it lets staff change ANY tenant, and a staff member who is
-- also a customer must reach only their own instances through this
-- endpoint. Another owner's instance, a deleted one and one that does not
-- exist are the same NotFound, and nothing is changed.

-- @prelude gate, validate, provisioner, jobs

function handle(input, ctx)
  local refused = gate_customer(ctx)
  if refused then return refused end

  if not is_uuid(input.idempotencyKey) then
    return failure("InvalidRequest", "idempotencyKey must be a UUID.")
  end
  local id = input.id
  if not is_uuid(id) then
    return failure("InvalidRequest", "id must be a UUID.")
  end
  local plan, version = input.plan, input.version
  if plan ~= nil and (type(plan) ~= "string" or plan == "") then
    return failure("InvalidRequest", "plan must be a plan id.")
  end
  if version ~= nil and (type(version) ~= "string" or version == "") then
    return failure("InvalidRequest", "version must be a HappyView release.")
  end
  if plan == nil and version == nil then
    return failure("InvalidRequest", "Give a plan, a version, or both.")
  end

  -- Safe in the path: is_uuid admits only hex digits and hyphens.
  local found, missing = owned_tenant(ctx, id)
  if not found then return missing end

  local status, body = provisioner(ctx, "PATCH", "/v1/tenants/" .. id, {
    plan = plan,
    version = version,
  }, input.idempotencyKey)
  if status ~= 202 or type(body) ~= "table" then
    return provisioner_failure(status, body)
  end

  local job_id, failed = follow_operation(body.operation)
  if not job_id then return failed end
  return { jobId = job_id }
end
