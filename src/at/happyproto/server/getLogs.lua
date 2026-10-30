-- at.happyproto.server.getLogs
--
-- A page of what one of the caller's instances wrote: the container's own
-- output, read from the host it runs on and redacted there. With
-- deploymentId, the page is bounded to that deployment's window and read
-- from the host it ran on. Customers only.
--
-- Ownership is checked here with owned_tenant first: the provisioner answers
-- staff with ANY tenant's logs.

-- @prelude gate, validate, urlencode, provisioner, deployments

local MAX_LIMIT = 1000
local DIRECTIONS = { forward = true, backward = true }

-- What the provisioner says about logs, passed through with its own words:
-- each message is a literal there, never built from internal state.
local LOG_CODES = {
  LogsUnavailable = true,
  LogsBusy = true,
  LogsTimeout = true,
  NotADeployment = true,
  InvalidRequest = true,
}

--- A journal cursor: `k=<hex>` fields joined by `;`.
local function is_cursor(c)
  if type(c) ~= "string" or #c == 0 or #c > 512 then return false end
  for field in (c .. ";"):gmatch("([^;]*);") do
    if not field:match("^%l=%x+$") then return false end
  end
  return true
end

--- An RFC 3339 time, loosely: the provisioner parses it properly.
local function is_time(t)
  return type(t) == "string" and #t <= 40 and t:match("^%d%d%d%d%-%d%d%-%d%dT%d%d:%d%d:%d%d") ~= nil
end

function handle(input, ctx)
  local refused = gate_customer(ctx)
  if refused then return refused end

  local id = input.id
  if not is_uuid(id) then
    return failure("InvalidRequest", "id must be a UUID.")
  end
  local params = {}
  local deployment_id = input.deploymentId
  if deployment_id ~= nil then
    if not is_uuid(deployment_id) then
      return failure("InvalidRequest", "deploymentId must be a UUID.")
    end
    -- Safe in the query: is_uuid admits only hex digits and hyphens.
    params[#params + 1] = "operation=" .. deployment_id
  end
  for _, name in ipairs({ "since", "until" }) do
    local t = input[name]
    if t ~= nil then
      if not is_time(t) then
        return failure("InvalidRequest", name .. " must be an RFC 3339 time.")
      end
      params[#params + 1] = name .. "=" .. url_encode(t)
    end
  end
  local cursor = input.cursor
  if cursor ~= nil then
    if not is_cursor(cursor) then
      return failure("InvalidRequest", "cursor must be one this method returned.")
    end
    params[#params + 1] = "cursor=" .. url_encode(cursor)
  end
  local direction = input.direction
  if direction ~= nil then
    if not DIRECTIONS[direction] then
      return failure("InvalidRequest", "direction must be forward or backward.")
    end
    params[#params + 1] = "direction=" .. direction
  end
  if input.limit ~= nil then
    local limit = tonumber(input.limit)
    if not limit or limit % 1 ~= 0 or limit < 1 or limit > MAX_LIMIT then
      return failure("InvalidRequest", "limit must be a whole number from 1 to " .. MAX_LIMIT .. ".")
    end
    params[#params + 1] = "limit=" .. string.format("%d", limit)
  end

  local found, missing = owned_tenant(ctx, id)
  if not found then return missing end

  local path = "/v1/tenants/" .. id .. "/logs"
  if #params > 0 then path = path .. "?" .. table.concat(params, "&") end
  local status, body = provisioner(ctx, "GET", path)
  if status ~= 200 or type(body) ~= "table" then
    if type(status) == "number" and status >= 400 and type(body) == "table"
      and LOG_CODES[body.error] and type(body.message) == "string" then
      return failure(body.error, body.message)
    end
    return provisioner_failure(status, body)
  end

  local page = public_log_page(body)
  page.lines = json.to_array(page.lines)
  return page
end
