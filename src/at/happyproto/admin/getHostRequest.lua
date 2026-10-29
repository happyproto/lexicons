-- at.happyproto.admin.getHostRequest
--
-- One host request with its timeline, oldest event first. Staff only.

-- @prelude gate, validate, json, provisioner, scaler

function handle(input, ctx)
  local refused = gate_admin(ctx)
  if refused then return refused end

  local id = input.id
  if not is_uuid(id) then
    return failure("InvalidRequest", "id must be a UUID.")
  end

  -- Safe in the path: is_uuid admits only hex digits and hyphens.
  local status, body = provisioner(ctx, "GET", "/v1/host-requests/" .. id)
  if status ~= 200 or type(body) ~= "table" or type(body.request) ~= "table" then
    return scaler_failure(status, body)
  end
  return { request = public_host_request(body.request) }
end
