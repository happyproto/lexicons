-- at.happyproto.server.getRecordsUsage
--
-- One of the caller's instances' records delivered over the current billing
-- period: by day, against the plan's allowance, with the surge cap, overage
-- and projection. Customers only; the dashboard's Usage tab. Nothing here is
-- billed.
--
-- Ownership is checked here first, with owned_tenant, and not left to the
-- provisioner: it lets staff read ANY tenant, and a staff member who is also
-- a customer must reach only their own instances through this endpoint.

-- @prelude gate, validate, provisioner, records

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
  local status, body = provisioner(ctx, "GET", "/v1/tenants/" .. id .. "/records-usage?period=current")
  if status ~= 200 or type(body) ~= "table" then
    return provisioner_failure(status, body)
  end
  return public_records(body)
end
