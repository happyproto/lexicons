-- at.happyproto.fleet.getCapacity
--
-- Store capacity and what each tenant holds, from the provisioner. Admin only.
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

  local query = {}
  for _, key in ipairs({ "from", "to" }) do
    if type(input[key]) == "string" and input[key] ~= "" then
      query[#query + 1] = key .. "=" .. url_encode(input[key])
    end
  end
  local path = "/v1/admin/capacity"
  if #query > 0 then
    path = path .. "?" .. table.concat(query, "&")
  end

  local status, body = provisioner(ctx, "GET", path)
  if status ~= 200 or type(body) ~= "table" then
    return provisioner_failure(status, body)
  end

  local out = {}
  local l = body.latest
  if type(l) == "table" then
    out.latest = {
      hour = l.hour,
      records = l.records,
      recordsBytes = l.records_bytes,
      recordsIndexBytes = l.records_index_bytes,
      overlayBytes = l.overlay_bytes,
      feedBytes = l.feed_bytes,
      databaseBytes = l.database_bytes,
      diskCapacityBytes = only(l.disk_capacity_bytes, "number"),
      diskFreeBytes = only(l.disk_free_bytes, "number"),
    }
  end

  local trend = {}
  for _, p in ipairs(type(body.trend) == "table" and body.trend or {}) do
    trend[#trend + 1] = { day = p.day, databaseBytes = p.database_bytes, records = p.records }
  end
  out.trend = json.to_array(trend)

  local collections = {}
  for _, c in ipairs(type(body.collections) == "table" and body.collections or {}) do
    collections[#collections + 1] = {
      nsid = c.nsid,
      records = c.records,
      subscribers = c.subscribers,
      crawl = only(c.crawl, "string"),
      configured = c.configured,
    }
  end
  out.collections = json.to_array(collections)

  local tenants = {}
  for _, t in ipairs(type(body.tenants) == "table" and body.tenants or {}) do
    local last = nil
    if type(t.last_hour) == "table" then
      last = {
        hour = t.last_hour.hour,
        cpuUsec = only(t.last_hour.cpu_usec, "number"),
        memAvgBytes = only(t.last_hour.mem_avg_bytes, "number"),
        egressBytes = only(t.last_hour.egress_bytes, "number"),
      }
    end
    tenants[#tenants + 1] = {
      id = t.id,
      slug = t.slug,
      plan = t.plan,
      collectionCount = only(t.collections, "number"),
      recordsVisible = only(t.records_visible, "number"),
      diskBytes = only(t.disk_bytes, "number"),
      seats = only(t.seats, "number"),
      apiClients = only(t.api_clients, "number"),
      lastHour = last,
      gaps7d = t.gaps_7d,
    }
  end
  out.tenants = json.to_array(tenants)

  return out
end
