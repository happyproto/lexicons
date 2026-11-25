-- at.happyproto.admin.unsuspendAccount
--
-- Lift an account's suspension (HAP-511): the provisioner starts again the
-- instances the suspension stopped, and leaves alone any its owner had
-- stopped. Lifting one that isn't suspended changes nothing. Staff only.

-- @prelude gate, validate, provisioner, urlencode, json

function handle(input, ctx)
  local refused = gate_admin(ctx)
  if refused then return refused end
  if not is_did(input.did) then
    return failure("InvalidRequest", "did must be a DID.")
  end
  if not is_uuid(input.idempotencyKey) then
    return failure("InvalidRequest", "idempotencyKey must be a UUID.")
  end

  local status, body = provisioner(ctx, "POST", "/v1/admin/accounts/" .. url_encode(input.did) .. "/unsuspend",
    nil, input.idempotencyKey)
  if status ~= 200 or type(body) ~= "table" or type(body.started) ~= "number" then
    return provisioner_failure(status, body)
  end
  return { started = body.started }
end
