-- at.happyproto.admin.listCustomers
--
-- The members of the customers space whose access the customer gate admits:
-- exactly the accounts the customer endpoints let in. Staff only.
--
-- A membership record is {did, access, read, write}, with no handle, so
-- handle is left out; the lexicon keeps it for a record that carries one.

-- @prelude gate, json

function handle(input, ctx)
  local refused = gate_admin(ctx)
  if refused then return refused end

  -- The gate has already derived the admin space from HAPPYPROTO_DID, so
  -- this is never nil in practice; checked anyway rather than concatenated.
  local uri = happyproto_space(ctx, CUSTOMERS_SPACE_TYPE)
  if not uri then
    return failure("Upstream", "customers space not configured")
  end

  -- pcall: members() RAISES for a space that does not exist, or with the
  -- spaces feature off.
  local ok, members = pcall(function()
    return spaces.get(uri):members()
  end)
  if not ok or type(members) ~= "table" then
    return failure("Upstream", "The customers space could not be read.")
  end

  local customers = {}
  for _, m in ipairs(members) do
    if type(m.did) == "string" and MEMBER_ACCESS[m.access] then
      customers[#customers + 1] = {
        did = m.did,
        handle = type(m.handle) == "string" and m.handle or nil,
      }
    end
  end
  return { customers = json.to_array(customers) }
end
