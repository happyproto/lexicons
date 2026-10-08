-- at.happyproto.admin.addCustomer
--
-- Make an account a customer: add it to the customers space with read
-- access. Staff only.
--
-- Idempotent: adding an account that is already a member succeeds and leaves
-- its access as it was.
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
  local uri = (ctx.env or {}).HAPPYPROTO_CUSTOMERS_SPACE
  if not uri or uri == "" then
    return failure("Upstream", "customers space not configured")
  end

  -- pcall: a spaces write RAISES its refusals. The error text carries the
  -- library's code: "... Plugin returned error: CONFLICT - ...".
  local ok, err = pcall(function()
    return spaces.get(uri):add_member({ did = input.did, access = "read" })
  end)
  if ok then return {} end
  err = tostring(err)
  if err:find("CONFLICT", 1, true) then
    -- Already a member.
    return {}
  end
  if err:find("NOT_AUTHORIZED", 1, true) then
    return failure("Forbidden", "Only the customers space's creator or a HappyView super user can change its members.")
  end
  log.warn("could not add a customer", { did = input.did, error = err })
  return failure("Upstream", "The customers space could not be changed.")
end
