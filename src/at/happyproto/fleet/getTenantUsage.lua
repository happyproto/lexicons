-- at.happyproto.fleet.getTenantUsage
--
-- One tenant's metered usage by hour or day, from the provisioner. Admin only.
-- The shape is the usage block's, shared with server.getUsage.

-- @prelude gate, provisioner, urlencode, usage

function handle(input, ctx)
  local refused = gate_admin(ctx)
  if refused then return refused end

  local query = usage_query(input)
  table.insert(query, 1, "tenant=" .. url_encode(input.tenant))
  local status, body = provisioner(ctx, "GET", "/v1/admin/usage?" .. table.concat(query, "&"))
  if status ~= 200 or type(body) ~= "table" then
    return provisioner_failure(status, body)
  end
  return public_usage(body)
end
