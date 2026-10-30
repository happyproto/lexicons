-- at.happyproto.server.getUsage
--
-- One of the caller's instances' metered usage, by hour or day, with the
-- hours that have no report. Customers only; the dashboard's Usage tab.
--
-- Ownership is checked here first, with owned_tenant, and not left to the
-- provisioner: it lets staff read ANY tenant, and a staff member who is also
-- a customer must reach only their own instances through this endpoint.
-- Another owner's instance and one that does not exist are the same NotFound.

-- @prelude gate, validate, provisioner, urlencode, usage

function handle(input, ctx)
  local refused = gate_customer(ctx)
  if refused then return refused end

  local id = input.id
  if not is_uuid(id) then
    return failure("InvalidRequest", "id must be a UUID.")
  end
  local found, missing = owned_tenant(ctx, id)
  if not found then return missing end

  -- Safe in the path: is_uuid admits only hex digits and hyphens.
  local path = "/v1/tenants/" .. id .. "/usage"
  local query = usage_query(input)
  if #query > 0 then
    path = path .. "?" .. table.concat(query, "&")
  end
  local status, body = provisioner(ctx, "GET", path)
  if status ~= 200 or type(body) ~= "table" then
    return provisioner_failure(status, body)
  end
  return public_usage(body)
end
