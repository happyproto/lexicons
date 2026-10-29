-- at.happyproto.admin.listHosts
--
-- Every host, with what its tenants hold. Staff only.
--
-- Each field is listed explicitly: a host's addresses, agent certificate and
-- contact count stay with the provisioner.
--
-- Free capacity and the plan lists come from a provisioner that knows them.
-- An older one sends neither, and they are left absent rather than guessed.

-- @prelude gate, provisioner

--- The strings of a JSON array, or nil when `v` is not one.
local function strings(v)
  if type(v) ~= "table" then return nil end
  local out = {}
  for _, s in ipairs(v) do
    if type(s) == "string" then out[#out + 1] = s end
  end
  return json.to_array(out)
end

local function integer_or_nil(v)
  return type(v) == "number" and v or nil
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
    hosts[#hosts + 1] = {
      id = h.id,
      name = h.name,
      state = h.state,
      memoryMb = h.memory_mb,
      cpuMillis = h.cpu_millis,
      diskGb = h.disk_gb,
      tenantCount = h.tenant_count,
      reservedMemoryMb = h.reserved_memory_mb,
      reservedDiskGb = h.reserved_disk_gb,
      -- Negative when the host is over-committed.
      freeMemoryMb = integer_or_nil(h.free_memory_mb),
      freeDiskGb = integer_or_nil(h.free_disk_gb),
      placeablePlans = strings(h.placeable_plans),
      -- A JSON null (never seen) is absent.
      lastSeenAt = type(h.last_seen_at) == "string" and h.last_seen_at or nil,
    }
  end
  return { hosts = json.to_array(hosts), unplaceablePlans = strings(body.unplaceable_plans) }
end
