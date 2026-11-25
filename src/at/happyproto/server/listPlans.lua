-- at.happyproto.server.listPlans
--
-- The plans a customer can pick for a new or changed instance. Customers only.
-- The provisioner lists only active plans; this renames the fields and passes
-- nothing else along. A priced plan also carries its tier, monthly price and
-- the records a month it includes, so the dashboard never hard-codes a price.

-- @prelude gate, provisioner

function handle(input, ctx)
  local refused = gate_customer(ctx)
  if refused then return refused end

  local status, body = provisioner(ctx, "GET", "/v1/plans")
  if status ~= 200 or type(body) ~= "table" or type(body.plans) ~= "table" then
    return provisioner_failure(status, body)
  end

  -- A JSON null decodes to a sentinel, not nil: keep only a value of the type.
  local function whole(v)
    local n = math.tointeger(v)
    return n and n >= 0 and n or nil
  end
  local function named(v)
    return type(v) == "string" and v ~= "" and v or nil
  end

  local plans = {}
  for _, p in ipairs(body.plans) do
    plans[#plans + 1] = {
      id = p.id,
      name = p.name,
      memoryMb = p.memory_mb,
      cpuMillis = p.cpu_millis,
      diskGb = p.disk_gb,
      tier = named(p.tier),
      priceCents = whole(p.price_cents),
      currency = named(p.currency),
      includedLiveRecords = whole(p.included_live_records),
      includedBackfillRecords = whole(p.included_backfill_records),
      -- The plan row's own limits (limit_*), never hard-coded here.
      seats = whole(p.limit_seats),
      logRetentionDays = whole(p.limit_log_retention_days) or whole(p.log_retention_days),
    }
  end
  return { plans = json.to_array(plans) }
end
