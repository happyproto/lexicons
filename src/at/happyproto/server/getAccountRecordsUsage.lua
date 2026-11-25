-- at.happyproto.server.getAccountRecordsUsage
--
-- Records delivered over the current billing period across all of the
-- caller's instances, each one's totals and their sum. Customers only.
-- Nothing here is billed. The provisioner reads only the caller's own
-- instances, by the DID this call carries.

-- @prelude gate, provisioner, records

function handle(input, ctx)
  local refused = gate_customer(ctx)
  if refused then return refused end

  local status, body = provisioner(ctx, "GET", "/v1/account/records-usage?period=current")
  if status ~= 200 or type(body) ~= "table" then
    return provisioner_failure(status, body)
  end
  return public_account_records(body)
end
