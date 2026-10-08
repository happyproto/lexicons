-- at.happyproto.server.getInstance
--
-- One of the caller's own instances. Customers only.
--
-- The provisioner answers staff with ANY tenant, so ownership is checked here
-- as well: another owner's instance is NotFound, with the provisioner's own
-- words, so "not yours" and "does not exist" stay indistinguishable.

-- @prelude gate, validate, provisioner, instance

function handle(input, ctx)
  local refused = gate_customer(ctx)
  if refused then return refused end

  local id = input.id
  if not is_uuid(id) then
    return failure("InvalidRequest", "id must be a UUID.")
  end

  local status, body = provisioner(ctx, "GET", "/v1/tenants/" .. id)
  if status ~= 200 or type(body) ~= "table" or type(body.tenant) ~= "table" then
    return provisioner_failure(status, body)
  end
  if body.tenant.owner_did ~= ctx.caller_did then
    return failure("NotFound", "instance not found")
  end
  return { instance = public_instance(body.tenant, body.current_operation) }
end
