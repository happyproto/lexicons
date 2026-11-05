-- at.happyproto.fleet.getTenantIngestMetrics
--
-- How any tenant handled incoming records in a window, by collection and
-- action. Read from the tenant's own HappyView through the provisioner,
-- which checks the caller is staff and records the read. Admin only. The
-- shape is the metrics block's, shared with server.getIngestMetrics.

-- @prelude gate, validate, provisioner, metrics

function handle(input, ctx)
  local refused = gate_admin(ctx)
  if refused then return refused end

  local tenant = input.tenant
  if not is_uuid(tenant) then
    return failure("InvalidRequest", "tenant must be a UUID.")
  end
  local asked, invalid = metrics_params({ window = input.window })
  if not asked then return invalid end

  -- Safe in the path: is_uuid admits only hex digits and hyphens.
  local status, body = provisioner(ctx, "GET", "/v1/tenants/" .. tenant .. "/metrics/ingest" .. asked.query)
  if status ~= 200 or type(body) ~= "table" then
    return metrics_failure(status, body)
  end
  return public_ingest(body)
end
