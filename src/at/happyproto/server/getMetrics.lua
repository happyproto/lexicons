-- at.happyproto.server.getMetrics
--
-- How one of the caller's instances is performing, as its HappyView reports
-- it: every script summarised, one script in detail, the record-ingest
-- stages, or what is running now. The provisioner relays the instance's own
-- report from its host; this passes it on untouched as `metrics`. Customers
-- only.
--
-- Ownership is checked here with owned_tenant first: the provisioner answers
-- staff with ANY tenant's metrics.

-- @prelude gate, validate, urlencode, provisioner

local VIEWS = { scripts = true, script = true, ingest = true, live = true }
local WINDOWS = { ["1h"] = true, ["24h"] = true, ["7d"] = true, ["30d"] = true }
local MAX_TRIGGER = 256

-- What the provisioner says about metrics, passed through with its own words:
-- each message is a literal there, never built from internal state.
local METRICS_CODES = {
  MetricsUnavailable = true,
  InvalidRequest = true,
}

--- A script's trigger as HappyView names it, e.g.
--- `xrpc.procedure:at.example.doThing` or `record:app.bsky.feed.post`:
--- printable, no spaces, nothing that needs more than url_encode.
local function is_trigger(t)
  return type(t) == "string" and #t > 0 and #t <= MAX_TRIGGER and t:match("^[%w%.%-_:/#%*]+$") ~= nil
end

function handle(input, ctx)
  local refused = gate_customer(ctx)
  if refused then return refused end

  local id = input.id
  if not is_uuid(id) then
    return failure("InvalidRequest", "id must be a UUID.")
  end
  local view = input.view
  if not VIEWS[view] then
    return failure("InvalidRequest", "view must be scripts, script, ingest or live.")
  end
  local params = {}
  local window = input.window
  if window ~= nil then
    if not WINDOWS[window] then
      return failure("InvalidRequest", "window must be 1h, 24h, 7d or 30d.")
    end
    params[#params + 1] = "window=" .. window
  end
  local trigger = input.trigger
  if view == "script" then
    if not is_trigger(trigger) then
      return failure("InvalidRequest", "view=script needs the script's trigger.")
    end
    params[#params + 1] = "trigger=" .. url_encode(trigger)
  elseif trigger ~= nil then
    return failure("InvalidRequest", "trigger applies only to view=script.")
  end

  local found, missing = owned_tenant(ctx, id)
  if not found then return missing end

  -- Safe in the path: is_uuid admits only hex digits and hyphens, and view is
  -- one of VIEWS.
  local path = "/v1/tenants/" .. id .. "/metrics/" .. view
  if #params > 0 then path = path .. "?" .. table.concat(params, "&") end
  local status, body = provisioner(ctx, "GET", path)
  if status ~= 200 or type(body) ~= "table" then
    if type(status) == "number" and status >= 400 and type(body) == "table"
      and METRICS_CODES[body.error] and type(body.message) == "string" then
      return failure(body.error, body.message)
    end
    return provisioner_failure(status, body)
  end

  return { view = view, metrics = body }
end
