-- at.happyproto.server.getInstance
--
-- One of the caller's own instances. Customers only.
--
-- The provisioner answers staff with ANY tenant, so owned_tenant checks
-- ownership here: another owner's instance is NotFound, with the
-- provisioner's own words, so "not yours" and "does not exist" stay
-- indistinguishable.
--
-- A deleted instance is NotFound too. The provisioner still returns it by id
-- until it is purged, but the list hides it, and an instance that is gone
-- from the list must not be reachable here.

-- @prelude gate, validate, provisioner, instance

function handle(input, ctx)
  local refused = gate_customer(ctx)
  if refused then return refused end

  local id = input.id
  if not is_uuid(id) then
    return failure("InvalidRequest", "id must be a UUID.")
  end

  local found, missing = owned_tenant(ctx, id)
  if not found then return missing end
  return { instance = public_instance(found.tenant, found.current_operation) }
end
