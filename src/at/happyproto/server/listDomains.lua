-- at.happyproto.server.listDomains
--
-- The domains of one of the caller's own instances: its platform subdomain,
-- which always serves it, and any custom domain. Customers only.
--
-- Ownership is checked here with owned_tenant, not left to the provisioner,
-- which answers staff for ANY tenant. While custom domains are switched off
-- the provisioner answers NotAvailable, and the dashboard hides its panel.

-- @prelude gate, validate, provisioner, domains

function handle(input, ctx)
  local refused = gate_customer(ctx)
  if refused then return refused end

  local id = input.instanceId
  if not is_uuid(id) then
    return failure("InvalidRequest", "instanceId must be a UUID.")
  end

  local found, missing = owned_tenant(ctx, id)
  if not found then return missing end

  local status, body = provisioner(ctx, "GET", "/v1/tenants/" .. id .. "/domains")
  if status ~= 200 or type(body) ~= "table" or type(body.platform) ~= "table" then
    return domain_failure(status, body)
  end

  local domains = {}
  for _, d in ipairs(type(body.domains) == "table" and body.domains or {}) do
    if type(d) == "table" then
      domains[#domains + 1] = public_domain(d)
    end
  end
  return {
    platform = {
      hostname = body.platform.hostname,
      primary = body.platform.primary == true,
    },
    domains = json.to_array(domains),
    -- Set only while a switch of primary is in flight.
    requestedPrimary = string_or_nil(body.requestedPrimary),
  }
end
