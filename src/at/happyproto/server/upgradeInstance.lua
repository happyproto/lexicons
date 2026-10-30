-- at.happyproto.server.upgradeInstance
--
-- Upgrade one of the caller's instances to the newer HappyView release its
-- availableVersion offers, and start the job that follows it. Customers only.
--
-- The caller names the release it was shown. The provisioner refuses with
-- UpgradeUnavailable unless that is still the one on offer, so a page left
-- open across a release, or after the upgrade, never moves the instance to
-- something the owner did not see. The agent snapshots the database first and
-- rolls back if the new release does not come up healthy.
--
-- Ownership is checked here first, with owned_tenant, and not left to the
-- provisioner: it lets staff change ANY tenant, and a staff member who is
-- also a customer must reach only their own instances through this
-- endpoint. Another owner's instance, a deleted one and one that does not
-- exist are the same NotFound, and nothing is changed.

-- @prelude gate, validate, provisioner, jobs

function handle(input, ctx)
  local refused = gate_customer(ctx)
  if refused then return refused end

  if not is_uuid(input.idempotencyKey) then
    return failure("InvalidRequest", "idempotencyKey must be a UUID.")
  end
  local id = input.id
  if not is_uuid(id) then
    return failure("InvalidRequest", "id must be a UUID.")
  end
  local version = input.version
  if type(version) ~= "string" or version == "" then
    return failure("InvalidRequest", "version must be the release availableVersion offers.")
  end

  -- Safe in the path: is_uuid admits only hex digits and hyphens.
  local found, missing = owned_tenant(ctx, id)
  if not found then return missing end

  local status, body = provisioner(ctx, "POST", "/v1/tenants/" .. id .. "/upgrade", {
    version = version,
  }, input.idempotencyKey)
  if status == 409 and type(body) == "table" and body.error == "UpgradeUnavailable" then
    return failure("UpgradeUnavailable", "That release is no longer on offer for this instance. Reload to see the current one.")
  end
  if status ~= 202 or type(body) ~= "table" then
    return provisioner_failure(status, body)
  end

  local job_id, failed = follow_operation(body.operation)
  if not job_id then return failed end
  return { jobId = job_id }
end
