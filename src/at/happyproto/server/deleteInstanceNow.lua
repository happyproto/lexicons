-- at.happyproto.server.deleteInstanceNow
--
-- "Delete now" (HAP-511): give up one of the caller's deleted instances' 7-day
-- grace period, so the provisioner purges it at once and it stops counting
-- toward the instance limit. The restore goes with it. Customers only.
--
-- Ownership is checked here first, as in deleteInstance, with deleted
-- instances included: those are the only ones this applies to.

-- @prelude gate, validate, provisioner, json

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
  local found, missing = owned_tenant(ctx, id, true)
  if not found then return missing end

  local status, body = provisioner(ctx, "POST", "/v1/tenants/" .. id .. "/purge-now", nil, input.idempotencyKey)
  if status == 409 and type(body) == "table" and body.error == "NotInGrace" then
    return failure("NotInGrace", "Only a deleted project can be deleted now.")
  end
  if status ~= 200 or type(body) ~= "table" then
    return provisioner_failure(status, body)
  end
  return { purging = body.purging == true }
end
