-- at.happyproto.server.listInstances
--
-- The caller's own instances. Customers only.
--
-- Always asks for owner_did = the caller. The provisioner treats a DID in its
-- STAFF_DIDS as staff, and for staff a list without owner_did is EVERY
-- tenant; a staff member who is also a customer must still see only their
-- own here. The admin endpoints are where staff see everyone's.

-- @prelude gate, urlencode, provisioner, instance

function handle(input, ctx)
  local refused = gate_customer(ctx)
  if refused then return refused end

  local status, body = provisioner(ctx, "GET", "/v1/tenants?owner_did=" .. url_encode(ctx.caller_did))
  if status ~= 200 or type(body) ~= "table" or type(body.tenants) ~= "table" then
    return provisioner_failure(status, body)
  end

  local instances = {}
  for _, t in ipairs(body.tenants) do
    -- Belt and braces: whatever the provisioner sent, only the caller's own.
    if t.owner_did == ctx.caller_did then
      instances[#instances + 1] = public_instance(t, t.current_operation)
    end
  end
  return { instances = json.to_array(instances) }
end
