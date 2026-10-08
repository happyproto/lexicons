-- at.happyproto.server.listPlans
--
-- The plans a customer can pick for a new or changed instance. Customers only.
-- The provisioner lists only active plans; this renames the fields and passes
-- nothing else along.

-- @prelude gate, provisioner

function handle(input, ctx)
  local refused = gate_customer(ctx)
  if refused then return refused end

  local status, body = provisioner(ctx, "GET", "/v1/plans")
  if status ~= 200 or type(body) ~= "table" or type(body.plans) ~= "table" then
    return provisioner_failure(status, body)
  end

  local plans = {}
  for _, p in ipairs(body.plans) do
    plans[#plans + 1] = {
      id = p.id,
      name = p.name,
      memoryMb = p.memory_mb,
      cpuMillis = p.cpu_millis,
      diskGb = p.disk_gb,
    }
  end
  return { plans = json.to_array(plans) }
end
