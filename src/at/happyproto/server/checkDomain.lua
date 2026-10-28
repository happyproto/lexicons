-- at.happyproto.server.checkDomain
--
-- Check one of the caller's custom domains now, rather than at its next
-- scheduled check. Customers only.
--
-- The provisioner runs the check before answering, and refuses one within a
-- few seconds of the last as TooSoon. A removed domain is NotFound.

-- @prelude gate, validate, provisioner, domains

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

  local status, body = provisioner(ctx, "POST",
    "/v1/tenants/" .. id .. "/domains/" .. domain_id .. "/verify", nil, input.idempotencyKey)
  if status ~= 200 or type(body) ~= "table" or type(body.id) ~= "string" then
    return domain_failure(status, body)
  end
  return { domain = public_domain(body) }
end
