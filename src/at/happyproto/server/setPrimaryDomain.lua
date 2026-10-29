-- at.happyproto.server.setPrimaryDomain
--
-- Make a domain the primary of one of the caller's own instances: a verified
-- custom domain that is serving, or the platform subdomain. Customers only.
--
-- The provisioner answers {operation}: null when the hostname is already the
-- requested primary, or the update that restarts the instance onto it, which
-- a job then follows. It refuses a domain that isn't verified (NotVerified),
-- isn't serving over HTTPS yet (CertificateNotReady), or an instance whose
-- HappyView is too old to switch safely (VersionTooOld). Switching back to
-- the platform subdomain is never refused for those last two.

-- @prelude gate, validate, provisioner, jobs, domains

function handle(input, ctx)
  local refused = gate_customer(ctx)
  if refused then return refused end

  if not is_uuid(input.idempotencyKey) then
    return failure("InvalidRequest", "idempotencyKey must be a UUID.")
  end
  local id = input.instanceId
  if not is_uuid(id) then
    return failure("InvalidRequest", "instanceId must be a UUID.")
  end
  local hostname = input.hostname
  if type(hostname) ~= "string" or hostname == "" or #hostname > 253 then
    return failure("InvalidRequest", "hostname must be a hostname of at most 253 characters.")
  end

  local found, missing = owned_tenant(ctx, id)
  if not found then return missing end

  local status, body = provisioner(ctx, "PUT", "/v1/tenants/" .. id .. "/primary-domain",
    { hostname = hostname }, input.idempotencyKey)
  if (status ~= 200 and status ~= 202) or type(body) ~= "table" then
    return domain_failure(status, body)
  end
  if type(body.operation) ~= "table" then
    return {}
  end
  local job_id, failed = follow_operation(body.operation)
  if not job_id then return failed end
  return { jobId = job_id }
end
