-- at.happyproto.actor.setNotices
--
-- Turn the caller's maintenance emails on or off (HAP-463), in their
-- preferences space. Account email (links they ask for, a note when their
-- contact email changes, changes to the terms) has no switch.
--
-- Customers and staff only, either gate admitting; each fails closed.

-- @prelude gate, validate, provisioner, preferences

function handle(input, ctx)
  if not ctx.caller_did or ctx.caller_did == "" then
    return failure("AuthRequired", "This endpoint requires an authenticated caller.")
  end
  if not is_uuid(input.idempotencyKey) then
    return failure("InvalidRequest", "idempotencyKey must be a UUID.")
  end
  if type(input.maintenance) ~= "boolean" then
    return failure("InvalidRequest", "maintenance must be true or false.")
  end
  if gate_customer(ctx) ~= nil and gate_admin(ctx) ~= nil then
    return failure("Forbidden", "Only customers and staff have contact settings.")
  end

  local uri = preferences.space(ctx, true)
  if not uri then return failure("Upstream", "Your preferences could not be saved.") end
  if not preferences.write(uri, preferences.NOTICES, { maintenance = input.maintenance }) then
    return failure("Upstream", "Your preferences could not be saved.")
  end
  return { maintenance = input.maintenance }
end
