-- at.happyproto.admin.listHosts
--
-- Every host, with what its tenants hold. Staff only.
--
-- Each field is listed explicitly: a host's addresses, agent certificate and
-- contact count stay with the provisioner.

-- @prelude gate, provisioner

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
      -- A JSON null (never seen) is absent.
      lastSeenAt = type(h.last_seen_at) == "string" and h.last_seen_at or nil,
    }
  end
  return { hosts = json.to_array(hosts) }
end
