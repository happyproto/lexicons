-- at.happyproto.admin.setAutoscalePaused
--
-- Pause or resume the autoscaler. Pausing stops new host requests; one
-- already under way carries on. Staff only.

-- @prelude gate, validate, json, provisioner, scaler

function handle(input, ctx)
  local refused = gate_admin(ctx)
  if refused then return refused end

  if not is_uuid(input.idempotencyKey) then
    return failure("InvalidRequest", "idempotencyKey must be a UUID.")
  end
  if type(input.paused) ~= "boolean" then
    return failure("InvalidRequest", "paused must be true or false.")
  end

  local status, body = provisioner(ctx, "PATCH", "/v1/autoscale", { paused = input.paused }, input.idempotencyKey)
  if status ~= 200 or type(body) ~= "table" then
    return scaler_failure(status, body)
  end
  return { autoscale = public_autoscale(body) }
end
