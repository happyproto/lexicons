-- at.happyproto.admin.getEncryptionKey
--
-- Where an instance's encryption key is in its rotation, and whether a
-- rotation can start now. Staff only.
--
-- The provisioner asks the instance's agent for the re-seal counts and for
-- whether its HappyView can report a rotation, so this read can be slower
-- than the others, and an unreachable host comes back as blockedBy, not an
-- error.

-- @prelude gate, validate, json, provisioner, instance, keys

function handle(input, ctx)
  local refused = gate_admin(ctx)
  if refused then return refused end

  local id = input.id
  if not is_uuid(id) then
    return failure("InvalidRequest", "id must be a UUID.")
  end

  -- Safe in the path: is_uuid admits only hex digits and hyphens.
  local status, body = provisioner(ctx, "GET", "/v1/tenants/" .. id .. "/encryption-key")
  if status ~= 200 or type(body) ~= "table" or type(body.stage) ~= "string" then
    return key_failure(status, body)
  end
  return { encryptionKey = admin_encryption_key(body) }
end
