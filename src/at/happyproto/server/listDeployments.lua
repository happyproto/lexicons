-- at.happyproto.server.listDeployments
--
-- The changes made to one of the caller's instances, newest first, a page at
-- a time. Customers only.
--
-- Each is a provisioner operation. isDeployment marks the ones that started
-- the instance's container; the rest (stop, delete, a domain change) are
-- events in the same history.
--
-- Ownership is checked here with owned_tenant first: the provisioner answers
-- staff with ANY tenant's operations.

-- @prelude gate, validate, provisioner, deployments

local DEFAULT_LIMIT = 20
local MAX_LIMIT = 100

function handle(input, ctx)
  local refused = gate_customer(ctx)
  if refused then return refused end

  local id = input.id
  if not is_uuid(id) then
    return failure("InvalidRequest", "id must be a UUID.")
  end
  local limit = input.limit
  if limit == nil then
    limit = DEFAULT_LIMIT
  else
    limit = tonumber(limit)
    if not limit or limit % 1 ~= 0 or limit < 1 or limit > MAX_LIMIT then
      return failure("InvalidRequest", "limit must be a whole number from 1 to " .. MAX_LIMIT .. ".")
    end
  end
  local cursor = input.cursor
  if cursor ~= nil and not is_uuid(cursor) then
    return failure("InvalidRequest", "cursor must be one this method returned.")
  end

  local found, missing = owned_tenant(ctx, id)
  if not found then return missing end

  -- Safe in the query: is_uuid admits only hex digits and hyphens.
  local path = "/v1/tenants/" .. id .. "/operations?limit=" .. string.format("%d", limit)
  if cursor then path = path .. "&before=" .. cursor end
  local status, body = provisioner(ctx, "GET", path)
  if status ~= 200 or type(body) ~= "table" or type(body.operations) ~= "table" then
    return provisioner_failure(status, body)
  end

  local deployments = {}
  for _, op in ipairs(body.operations) do
    if type(op) == "table" and op.tenant_id == id then
      deployments[#deployments + 1] = public_deployment(op, found.tenant.owner_did)
    end
  end
  return {
    deployments = json.to_array(deployments),
    cursor = is_uuid(body.cursor) and body.cursor or nil,
  }
end
