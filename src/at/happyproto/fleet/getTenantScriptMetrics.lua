-- at.happyproto.fleet.getTenantScriptMetrics
--
-- How any tenant's scripts ran in a window: every script that ran, or with
-- trigger, one script's series. Read from the tenant's own HappyView through
-- the provisioner, which checks the caller is staff and records the read.
-- Admin only. The shape is the metrics block's, shared with
-- server.getScriptMetrics.

-- @prelude gate, validate, provisioner, metrics

function handle(input, ctx)
  local refused = gate_admin(ctx)
  if refused then return refused end

  local tenant = input.tenant
  if not is_uuid(tenant) then
    return failure("InvalidRequest", "tenant must be a UUID.")
  end
  local asked, invalid = metrics_params(input)
  if not asked then return invalid end

  -- Safe in the path: is_uuid admits only hex digits and hyphens, and the
  -- trigger is percent-encoded.
  local path = "/v1/tenants/" .. tenant .. "/metrics/scripts"
  if asked.trigger then
    local status, body = provisioner(ctx, "GET", path .. "/" .. asked.trigger .. asked.query)
    if status ~= 200 or type(body) ~= "table" then
      return script_metrics_failure(status, body)
    end
    return public_script_series(body)
  end
  local status, body = provisioner(ctx, "GET", path .. asked.query)
  if status ~= 200 or type(body) ~= "table" then
    return metrics_failure(status, body)
  end
  return public_script_list(body)
end
