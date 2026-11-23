-- at.happyproto.actor.leaveCapacityQueue
--
-- Take the caller out of the capacity queue (HAP-511), which a create that
-- found no room put them in. Customers only.

-- @prelude gate, validate, provisioner, json

function handle(input, ctx)
  local refused = gate_customer(ctx)
  if refused then return refused end
  if not is_uuid(input.idempotencyKey) then
    return failure("InvalidRequest", "idempotencyKey must be a UUID.")
  end
  local status, body = provisioner(ctx, "DELETE", "/v1/account/capacity-wait", nil, input.idempotencyKey)
  if status ~= 200 or type(body) ~= "table" or type(body.removed) ~= "boolean" then
    return provisioner_failure(status, body)
  end
  return { removed = body.removed }
end
