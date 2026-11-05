-- at.happyproto.admin.getFleet
--
-- Every host, and every tenant with its host, plan, owner and latest metered
-- hour, for the staff fleet view (HAP-386). Staff only.
--
-- The hosts list goes first and must succeed, as in admin.listInstances: it
-- is staff-only at the provisioner too, so a staff member the provisioner
-- doesn't know gets its Forbidden rather than an empty fleet.
--
-- Every field is listed explicitly. An owner's email is passed on only here:
-- this method is gated twice, by the admin space and by the provisioner's
-- STAFF_DIDS. A tenant with no metered hour has no usage, never zeros.

-- @prelude gate, provisioner, scaler

--- A string worth showing: nil for a missing or blank one.
local function shown(v)
  local s = text_or_nil(v)
  return s and s:match("%S") and s or nil
end

local function fleet_host(h)
  return {
    id = h.id,
    name = h.name,
    state = h.state,
    memoryMb = h.memory_mb,
    diskGb = h.disk_gb,
    tenantCount = h.tenant_count,
    reservedMemoryMb = h.reserved_memory_mb,
    reservedDiskGb = h.reserved_disk_gb,
    -- Negative when the host is over-committed; absent from an older
    -- provisioner.
    freeMemoryMb = number_or_nil(h.free_memory_mb),
    freeDiskGb = number_or_nil(h.free_disk_gb),
    lastSeenAt = shown(h.last_seen_at),
  }
end

local function fleet_tenant(t)
  local plan = type(t.plan) == "table" and t.plan or {}
  local owner = type(t.owner) == "table" and t.owner or {}
  local email = shown(owner.email)
  -- Only beside an email, and false for one that isn't confirmed. Not
  -- `email and confirmed or nil`: that drops a false to nil, which would
  -- hide that an address is unconfirmed.
  local email_confirmed
  if email then
    email_confirmed = owner.email_confirmed == true
  end
  local usage
  if type(t.usage) == "table" and type(t.usage.hour) == "string" then
    local u = t.usage
    usage = {
      hour = u.hour,
      diskAvgBytes = number_or_nil(u.disk_avg_bytes),
      diskPeakBytes = number_or_nil(u.disk_peak_bytes),
      memPeakBytes = number_or_nil(u.mem_peak_bytes),
      memAvgBytes = number_or_nil(u.mem_avg_bytes),
      seats = number_or_nil(u.seats),
      apiClients = number_or_nil(u.api_clients),
      partial = u.partial == true,
    }
  end
  return {
    id = t.id,
    slug = t.slug,
    hostId = shown(t.host_id),
    desiredState = t.desired_state,
    observedState = t.observed_state,
    version = t.happyview_version,
    createdAt = t.created_at,
    plan = {
      id = plan.id,
      name = shown(plan.name),
      memoryMb = number_or_nil(plan.memory_mb),
      diskGb = number_or_nil(plan.disk_gb),
    },
    owner = {
      did = owner.did,
      email = email,
      emailConfirmed = email_confirmed,
    },
    usage = usage,
  }
end

function handle(input, ctx)
  local refused = gate_admin(ctx)
  if refused then return refused end

  local status, body = provisioner(ctx, "GET", "/v1/hosts")
  if status ~= 200 or type(body) ~= "table" or type(body.hosts) ~= "table" then
    return provisioner_failure(status, body)
  end
  local hosts = {}
  for _, h in ipairs(body.hosts) do
    hosts[#hosts + 1] = fleet_host(h)
  end

  status, body = provisioner(ctx, "GET", "/v1/admin/tenants")
  if status ~= 200 or type(body) ~= "table" or type(body.tenants) ~= "table" then
    return provisioner_failure(status, body)
  end
  local tenants = {}
  for _, t in ipairs(body.tenants) do
    tenants[#tenants + 1] = fleet_tenant(t)
  end

  return { hosts = json.to_array(hosts), tenants = json.to_array(tenants) }
end
