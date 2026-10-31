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
-- A trigger's kinds, as HappyView and the agent name them.
local TRIGGER_KINDS = {
  ["record.index"] = true, ["record.create"] = true, ["record.update"] = true, ["record.delete"] = true,
  ["xrpc.query"] = true, ["xrpc.procedure"] = true, ["labeler.apply"] = true, ["job.run"] = true,
}
-- An NSID's limit; a job type's is lower.
local MAX_TARGET = 317

-- What the provisioner says about metrics, passed through with its own words:
-- each message is a literal there, never built from internal state.
local METRICS_CODES = {
  MetricsUnavailable = true,
  MetricsTimeout = true,
  NoRuns = true,
  InvalidRequest = true,
}

--- A script's trigger id, `<kind>:<target>`, e.g. `xrpc.query:games.example.listGames`
--- or `record.create:app.bsky.feed.post`: the same check the agent applies.
local function is_trigger(t)
  if type(t) ~= "string" then return false end
  local kind, target = t:match("^([%a.]+):(.+)$")
  return kind ~= nil and TRIGGER_KINDS[kind] == true
    and #target <= MAX_TARGET and target:match("^[%w._*%-]+$") ~= nil
end

-- The arrays in each view's report, at its top level. An empty one decodes
-- to an empty table, which would go back out as {}; these keep it a list.
-- Arrays deeper in (host_imports, layers) are the dashboard's to tolerate.
local ARRAYS = { "scripts", "collections", "points", "layers", "backfill_jobs" }

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

  for _, name in ipairs(ARRAYS) do
    if type(body[name]) == "table" then body[name] = json.to_array(body[name]) end
  end
  return { view = view, metrics = body }
end
