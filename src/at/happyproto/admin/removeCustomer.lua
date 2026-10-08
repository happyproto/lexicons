-- at.happyproto.admin.removeCustomer
--
-- Stop an account being a customer: remove it from the customers space.
-- Staff only.
--
-- Idempotent: removing an account that is not a member succeeds.
--
-- happyview.spaces runs the write as the caller, and HappyView lets only the
-- space's creator or a HappyView super user change its members, so a staff
-- member who is neither is refused, and told why.

-- @prelude gate, validate, json

local log = require("internal.logging")

function handle(input, ctx)
  local refused = gate_admin(ctx)
  if refused then return refused end

  if not is_did(input.did) then
    return failure("InvalidRequest", "did must be a DID.")
  end
  -- The gate has already derived the admin space from HAPPYPROTO_DID, so
  -- this is never nil in practice; checked anyway rather than concatenated.
  local uri = happyproto_space(ctx, CUSTOMERS_SPACE_TYPE)
  if not uri then
    return failure("Upstream", "customers space not configured")
  end

  -- pcall: a spaces write RAISES its refusals. The error text carries the
  -- library's code: "... Plugin returned error: NOT_FOUND - ...".
  local ok, err = pcall(function()
    return spaces.get(uri):remove_member({ did = input.did })
  end)
  if ok then return {} end
  err = tostring(err)
  if err:find("NOT_AUTHORIZED", 1, true) then
    return failure("Forbidden", "Only the customers space's creator or a HappyView super user can change its members.")
  end
  -- NOT_FOUND is either "not a member", which is success here, or no such
  -- space. info() tells them apart: it answers nil only for the second.
  if err:find("NOT_FOUND", 1, true) then
    local found, space = pcall(spaces.info, uri)
    if found and type(space) == "table" then
      return {}
    end
  end
  log.warn("could not remove a customer", { did = input.did, error = err })
  return failure("Upstream", "The customers space could not be changed.")
end
