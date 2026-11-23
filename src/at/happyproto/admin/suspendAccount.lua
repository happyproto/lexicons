-- at.happyproto.admin.suspendAccount
--
-- Suspend an account (HAP-511): the provisioner stops its running instances
-- and refuses its owner's creates, starts, changes, upgrades and new custom
-- domains until staff lift it with admin.unsuspendAccount. The account stays
-- a customer, so it can still sign in and see why. Staff only.

-- @prelude gate, validate, provisioner, urlencode, json

function handle(input, ctx)
  local refused = gate_admin(ctx)
  if refused then return refused end
  if not is_did(input.did) then
    return failure("InvalidRequest", "did must be a DID.")
  end
  if not is_uuid(input.idempotencyKey) then
    return failure("InvalidRequest", "idempotencyKey must be a UUID.")
  end
  local reason = type(input.reason) == "string" and input.reason:match("^%s*(.-)%s*$") or ""
  -- Characters, as the provisioner counts them; bytes where utf8 is missing.
  local length = (utf8 and utf8.len(reason)) or #reason
  if #reason == 0 or not length or length > 500 then
    return failure("InvalidRequest", "reason must be 1 to 500 characters.")
  end

  local status, body = provisioner(ctx, "POST", "/v1/admin/accounts/" .. url_encode(input.did) .. "/suspend",
    { reason = reason }, input.idempotencyKey)
  if status ~= 200 or type(body) ~= "table" or type(body.stopped) ~= "number" then
    return provisioner_failure(status, body)
  end
  return { stopped = body.stopped }
end
