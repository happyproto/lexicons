-- at.happyproto.server.startInstance
--
-- Start one of the caller's instances, and start the job that follows it.
-- Customers only.
--
-- The provisioner checks ownership: another owner's instance is NotFound
-- there, indistinguishable from one that does not exist.

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

  -- Safe in the path: is_uuid admits only hex digits and hyphens.
  local status, body = provisioner(ctx, "POST", "/v1/tenants/" .. id .. "/start", nil, input.idempotencyKey)
  if status ~= 202 or type(body) ~= "table" then
    return provisioner_failure(status, body)
  end

  local job_id, failed = follow_operation(body.operation)
  if not job_id then return failed end
  return { jobId = job_id }
end
