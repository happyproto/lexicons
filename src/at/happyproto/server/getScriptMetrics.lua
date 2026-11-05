-- at.happyproto.server.getScriptMetrics
--
-- How one of the caller's instances' scripts ran in a window: every script
-- that ran, or with trigger, one script's series. Read from the instance's
-- own HappyView through the provisioner. Customers only.
--
-- Ownership is checked here with owned_tenant first: the provisioner answers
-- staff with ANY tenant's metrics.

-- @prelude gate, validate, provisioner, metrics

function handle(input, ctx)
  local refused = gate_customer(ctx)
  if refused then return refused end

  local id = input.id
  if not is_uuid(id) then
    return failure("InvalidRequest", "id must be a UUID.")
  end
  local asked, invalid = metrics_params(input)
  if not asked then return invalid end

  local found, missing = owned_tenant(ctx, id)
  if not found then return missing end

  -- Safe in the path: is_uuid admits only hex digits and hyphens, and the
  -- trigger is percent-encoded.
  local path = "/v1/tenants/" .. id .. "/metrics/scripts"
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
