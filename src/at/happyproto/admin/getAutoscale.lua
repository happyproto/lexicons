-- at.happyproto.admin.getAutoscale
--
-- The autoscaler: whether it is on or paused, how many hosts it may add,
-- what it is waiting on, and free capacity against its thresholds. Staff
-- only.

-- @prelude gate, json, provisioner, scaler

function handle(input, ctx)
  local refused = gate_admin(ctx)
  if refused then return refused end

  local status, body = provisioner(ctx, "GET", "/v1/autoscale")
  if status ~= 200 or type(body) ~= "table" then
    return scaler_failure(status, body)
  end
  return { autoscale = public_autoscale(body) }
end
