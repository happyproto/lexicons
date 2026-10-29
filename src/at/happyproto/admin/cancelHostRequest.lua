-- at.happyproto.admin.cancelHostRequest
--
-- Cancel a host request: its server and volume are removed. `confirm` must
-- be the request's host name, as typed by the member of staff. Staff only.

-- @prelude gate, validate, json, provisioner, scaler

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
  if type(input.confirm) ~= "string" or input.confirm == "" or #input.confirm > 63 then
    return failure("InvalidRequest", "confirm must be the request's host name.")
  end

  -- Safe in the path: is_uuid admits only hex digits and hyphens.
  local status, body = provisioner(ctx, "POST", "/v1/host-requests/" .. id .. "/cancel",
    { confirm = input.confirm }, input.idempotencyKey)
  if status ~= 200 or type(body) ~= "table" or type(body.request) ~= "table" then
    return scaler_failure(status, body)
  end
  return { request = public_host_request(body.request) }
end
