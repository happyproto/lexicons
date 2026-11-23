-- at.happyproto.admin.getAccount
--
-- An account as the provisioner holds it: the beta cohort it joined in, its
-- instance count, and its suspension, if any (HAP-511). Staff only.

-- @prelude gate, validate, provisioner, urlencode, json

function handle(input, ctx)
  local refused = gate_admin(ctx)
  if refused then return refused end
  if not is_did(input.did) then
    return failure("InvalidRequest", "did must be a DID.")
  end

  local status, body = provisioner(ctx, "GET", "/v1/admin/accounts/" .. url_encode(input.did))
  if status ~= 200 or type(body) ~= "table" or type(body.account) ~= "table" then
    return provisioner_failure(status, body)
  end
  local a = body.account
  local suspension = nil
  if type(a.suspension) == "table" then
    suspension = {
      suspendedAt = a.suspension.suspended_at,
      suspendedBy = a.suspension.suspended_by,
      reason = a.suspension.reason,
    }
  end
  return {
    did = a.did,
    cohort = a.cohort,
    createdAt = a.created_at,
    instanceCount = a.instance_count,
    suspension = suspension,
  }
end
