-- at.happyproto.fleet.getTenantUsage
--
-- One tenant's metered usage by hour or day, from the provisioner. Admin only.
--
-- Each field is listed explicitly, so a field the provisioner adds later is
-- never passed along by accident. JSON nulls (nil in Lua) are absent.

-- @prelude gate, provisioner, urlencode

-- A JSON null decodes to a sentinel, not nil: keep only a value of the type.
local function only(v, kind)
  if type(v) == kind then
    return v
  end
  return nil
end

function handle(input, ctx)
  local refused = gate_admin(ctx)
  if refused then return refused end

  local query = { "tenant=" .. url_encode(input.tenant) }
  for _, key in ipairs({ "from", "to", "grain" }) do
    if type(input[key]) == "string" and input[key] ~= "" then
      query[#query + 1] = key .. "=" .. url_encode(input[key])
    end
  end

  local status, body = provisioner(ctx, "GET", "/v1/admin/usage?" .. table.concat(query, "&"))
  if status ~= 200 or type(body) ~= "table" then
    return provisioner_failure(status, body)
  end

  local rows = {}
  for _, r in ipairs(type(body.rows) == "table" and body.rows or {}) do
    rows[#rows + 1] = {
      hour = r.hour,
      day = r.day,
      runningSeconds = r.running_seconds,
      cpuUsec = r.cpu_usec,
      memByteSeconds = r.mem_byte_seconds,
      memPeakBytes = r.mem_peak_bytes,
      egressBytes = r.egress_bytes,
      ingressBytes = r.ingress_bytes,
      diskAvgBytes = only(r.disk_avg_bytes, "number"),
      diskPeakBytes = only(r.disk_peak_bytes, "number"),
      seats = only(r.seats, "number"),
      apiClients = only(r.api_clients, "number"),
      partial = r.partial,
    }
  end

  local gaps = {}
  for _, g in ipairs(type(body.gaps) == "table" and body.gaps or {}) do
    gaps[#gaps + 1] = { hour = g.hour, reason = g.reason }
  end

  return {
    tenant = body.tenant,
    grain = body.grain,
    rows = json.to_array(rows),
    gaps = json.to_array(gaps),
  }
end
