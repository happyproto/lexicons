-- at.happyproto.server.removeDomain
--
-- Remove a custom domain from one of the caller's own instances. Customers
-- only.
--
-- The provisioner answers {operation}: null when nothing was routing the
-- domain yet, or the update that takes it off the instance's host, which a
-- job then follows. The instance does not restart either way. The primary
-- domain is refused as DomainIsPrimary; a removed or unknown one is NotFound.

-- @prelude gate, validate, provisioner, jobs, domains

function handle(input, ctx)
  local refused = gate_customer(ctx)
  if refused then return refused end

  if not is_uuid(input.idempotencyKey) then
    return failure("InvalidRequest", "idempotencyKey must be a UUID.")
  end
  local id, domain_id = input.instanceId, input.domainId
  if not is_uuid(id) then
    return failure("InvalidRequest", "instanceId must be a UUID.")
  end
  if not is_uuid(domain_id) then
    return failure("InvalidRequest", "domainId must be a UUID.")
  end

  local found, missing = owned_tenant(ctx, id)
  if not found then return missing end

  local status, body = provisioner(ctx, "DELETE",
    "/v1/tenants/" .. id .. "/domains/" .. domain_id, nil, input.idempotencyKey)
  if (status ~= 200 and status ~= 202) or type(body) ~= "table" then
    return domain_failure(status, body)
  end
  if type(body.operation) ~= "table" then
    return {}
  end
  local job_id, failed = follow_operation(body.operation)
  if not job_id then return failed end
  return { jobId = job_id }
end
