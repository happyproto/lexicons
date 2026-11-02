-- at.happyproto.admin.rotateEncryptionKey
--
-- Give an instance a new encryption key. The provisioner keeps the old one
-- beside it while HappyView re-seals what the old one sealed, then retires
-- it on its own. Staff only.

-- @prelude gate, validate, json, provisioner, instance, keys

function handle(input, ctx)
  local refused = gate_admin(ctx)
  if refused then return refused end

  if not is_uuid(input.idempotencyKey) then
    return failure("InvalidRequest", "idempotencyKey must be a UUID.")
  end
  local id = input.id
  if not is_uuid(id) then
    return failure("InvalidRequest", "id must be a UUID.")
  end

  -- Safe in the path: is_uuid admits only hex digits and hyphens.
  local status, body = provisioner(ctx, "POST", "/v1/tenants/" .. id .. "/encryption-key/rotate", nil,
    input.idempotencyKey)
  local operation = status == 202 and type(body) == "table" and public_operation(body.operation) or nil
  if not operation then
    return key_failure(status, body)
  end
  return { operation = operation }
end
