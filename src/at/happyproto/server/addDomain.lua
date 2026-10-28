-- at.happyproto.server.addDomain
--
-- Add a custom domain to one of the caller's own instances. Customers only.
--
-- The domain starts pending, with the TXT and CNAME records to publish. The
-- provisioner owns every hostname rule (no platform names, no public
-- suffixes, one domain per instance); this only refuses what cannot be a
-- hostname at all, so the provisioner's reason reaches the caller.

-- @prelude gate, validate, provisioner, domains

function handle(input, ctx)
  local refused = gate_customer(ctx)
  if refused then return refused end

  if not is_uuid(input.idempotencyKey) then
    return failure("InvalidRequest", "idempotencyKey must be a UUID.")
  end
  local id = input.instanceId
  if not is_uuid(id) then
    return failure("InvalidRequest", "instanceId must be a UUID.")
  end
  local hostname = input.hostname
  if type(hostname) ~= "string" or hostname == "" or #hostname > 253 then
    return failure("InvalidRequest", "hostname must be a hostname of at most 253 characters.")
  end

  -- Safe in the path: is_uuid admits only hex digits and hyphens.
  local found, missing = owned_tenant(ctx, id)
  if not found then return missing end

  local status, body = provisioner(ctx, "POST", "/v1/tenants/" .. id .. "/domains",
    { hostname = hostname }, input.idempotencyKey)
  if status ~= 201 or type(body) ~= "table" or type(body.id) ~= "string" then
    return domain_failure(status, body)
  end
  return { domain = public_domain(body) }
end
