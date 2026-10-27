-- at.happyproto.admin.createInvites
--
-- Invite customers: one single-use customers-space invite per address, and a
-- record of which address each went to. Staff only.
--
-- The invites are HappyView's own: the space keeps a hash of each token, its
-- access, its use count and its expiry, and accept_invite enforces all four.
-- The addresses go to the provisioner, never into HappyView, keyed there by
-- the token's hash, so actor.acceptInvite can pair the address with the
-- account that redeems it.
--
-- Tokens are handed back only once every address is recorded. An invite
-- whose address could not be recorded is never sent, so it can never be
-- redeemed without leaving a trace; it simply expires.
--
-- happyview.spaces runs the write as the caller, and HappyView lets only the
-- space's creator or a HappyView super user create its invites, the same rule
-- as addCustomer, so a staff member who is neither is refused, and told why.
-- Recording the addresses needs the caller in the provisioner's STAFF_DIDS.

-- @prelude gate, validate, provisioner, json

local DAY = 86400

local function whole(n, low, high)
  return type(n) == "number" and n == math.floor(n) and n >= low and n <= high
end

--- The addresses, trimmed and lowercased, or nil when the list is not 1 to
--- 50 distinct addresses of the waitlist's shape.
local function addresses(list)
  if type(list) ~= "table" or #list < 1 or #list > 50 then return nil end
  local out, seen = {}, {}
  for _, raw in ipairs(list) do
    if type(raw) ~= "string" then return nil end
    local email = raw:match("^%s*(.-)%s*$"):lower()
    if #email > 254 or not email:match("^[^@%s]+@[^@%s]+%.[^@%s]+$")
      or email:find("..", 1, true) or email:find("@.", 1, true) or email:sub(-1) == "." then
      return nil
    end
    if seen[email] then return nil end
    seen[email] = true
    out[#out + 1] = email
  end
  return out
end

--- A provisioner refusal of an invites route, as this endpoint's errors.
--- Only Forbidden (the caller is not in STAFF_DIDS) and an in-flight retry
--- mean anything to the caller; every other reply is Upstream, logged.
local function invites_failure(status, body)
  local code = type(body) == "table" and body.error or nil
  if status == 403 then
    return failure("Forbidden", "Only staff the provisioner knows can manage invites.")
  end
  if code == "IdempotencyKeyInFlight" then
    return failure("OperationInProgress", "This request is already in progress. Try again shortly.")
  end
  log.warn("provisioner refused an invites request", { status = status, body = body })
  return failure("Upstream", "The provisioner could not complete the request.")
end

function handle(input, ctx)
  local refused = gate_admin(ctx)
  if refused then return refused end

  if not is_uuid(input.idempotencyKey) then
    return failure("InvalidRequest", "idempotencyKey must be a UUID.")
  end
  local emails = addresses(input.emails)
  if not emails then
    return failure("InvalidRequest", "emails must be 1 to 50 distinct email addresses.")
  end
  local days = input.expiresInDays
  if days == nil then days = 14 end
  if not whole(days, 1, 30) then
    return failure("InvalidRequest", "expiresInDays must be a whole number from 1 to 30.")
  end

  local uri = happyproto_space(ctx, CUSTOMERS_SPACE_TYPE)
  if not uri then
    return failure("Upstream", "customers space not configured")
  end

  -- HappyView compares expires_at to its own clock as RFC 3339 text in UTC,
  -- so it is written in exactly that shape.
  local expires_at = os.date("!%Y-%m-%dT%H:%M:%S+00:00", os.time() + days * DAY)
  local space = spaces.get(uri)
  local minted = {}
  for i, email in ipairs(emails) do
    -- pcall: a spaces write RAISES its refusals.
    local ok, invite = pcall(function()
      return space:create_invite({ access = "read", max_uses = 1, expires_at = expires_at })
    end)
    if not ok or type(invite) ~= "table" or type(invite.token) ~= "string" then
      if i == 1 and tostring(invite):find("NOT_AUTHORIZED", 1, true) then
        return failure("Forbidden", "Only the customers space's creator or a HappyView super user can invite customers.")
      end
      return failure("Upstream", "The customers space could not make an invite.")
    end
    minted[i] = { email = email, token = invite.token, expires_at = expires_at }
  end

  local status, body = provisioner(ctx, "POST", "/v1/invites", {
    invites = json.to_array(minted),
  }, input.idempotencyKey)
  if status ~= 201 then
    return invites_failure(status, body)
  end

  local invites = {}
  for i, m in ipairs(minted) do
    invites[i] = { email = m.email, token = m.token, expiresAt = m.expires_at }
  end
  return { invites = json.to_array(invites) }
end
