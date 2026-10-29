-- at.happyproto.admin.listHostRequests
--
-- The autoscaler's host requests, newest first, without their timelines.
-- Staff only. `before` is the id of the last request on the previous page.

-- @prelude gate, validate, json, provisioner, scaler

function handle(input, ctx)
  local refused = gate_admin(ctx)
  if refused then return refused end

  -- Checked here so the provisioner's InvalidQuery never arises.
  local limit = 50
  if input.limit ~= nil then
    limit = math.tointeger(tonumber(input.limit))
    if not limit or limit < 1 or limit > 200 then
      return failure("InvalidRequest", "limit must be a whole number from 1 to 200.")
    end
  end
  local path = "/v1/host-requests?limit=" .. limit
  local before = input.before
  if before ~= nil then
    if not is_uuid(before) then
      return failure("InvalidRequest", "before must be a UUID.")
    end
    -- Safe in the query: is_uuid admits only hex digits and hyphens.
    path = path .. "&before=" .. before
  end

  local status, body = provisioner(ctx, "GET", path)
  if status ~= 200 or type(body) ~= "table" or type(body.requests) ~= "table" then
    return scaler_failure(status, body)
  end
  local requests = {}
  for _, r in ipairs(body.requests) do
    requests[#requests + 1] = public_host_request(r)
  end
  return { requests = json.to_array(requests) }
end
