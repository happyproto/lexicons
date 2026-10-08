-- at.happyproto.admin.listInstances
--
-- Every instance, whoever owns it, with the name of the host it is on. Staff
-- only.
--
-- The provisioner decides who is staff on its side too (STAFF_DIDS). The
-- hosts list goes first and must succeed: it is staff-only there, so a staff
-- member the provisioner does not know gets its Forbidden. The tenant list
-- alone would not say so -- for a non-staff actor it quietly answers with
-- their own tenants, which would pass for the whole fleet.

-- @prelude gate, validate, urlencode, provisioner, instance

function handle(input, ctx)
  local refused = gate_admin(ctx)
  if refused then return refused end

  local owner = input.owner
  if owner ~= nil and not is_did(owner) then
    return failure("InvalidRequest", "owner must be a DID.")
  end

  local status, body = provisioner(ctx, "GET", "/v1/hosts")
  if status ~= 200 or type(body) ~= "table" or type(body.hosts) ~= "table" then
    return provisioner_failure(status, body)
  end
  local host_names = {}
  for _, h in ipairs(body.hosts) do
    host_names[h.id] = h.name
  end

  local path = "/v1/tenants"
  if owner ~= nil then
    path = path .. "?owner_did=" .. url_encode(owner)
  end
  status, body = provisioner(ctx, "GET", path)
  if status ~= 200 or type(body) ~= "table" or type(body.tenants) ~= "table" then
    return provisioner_failure(status, body)
  end

  local instances = {}
  for _, t in ipairs(body.tenants) do
    local host_name = type(t.host_id) == "string" and host_names[t.host_id] or nil
    instances[#instances + 1] = admin_instance(t, t.current_operation, host_name)
  end
  return { instances = json.to_array(instances) }
end
