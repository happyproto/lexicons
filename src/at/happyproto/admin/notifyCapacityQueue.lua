-- at.happyproto.admin.notifyCapacityQueue
--
-- Tell the owners in the capacity queue who are due a notice that there's
-- room again (HAP-511): staff press it when the "can be placed again" alert
-- says owners are waiting. Staff only.
--
-- The provisioner keeps no addresses, so this reads each due owner's contact
-- address from their preferences space and hands it to the provisioner,
-- which sends only to an address proven to be theirs, counted against the
-- shared email budget. At most MAX_PER_CALL owners a call; when the budget is
-- full it stops and says when to try again. Owners with no contact address
-- are left waiting: the dashboard tells them when they next look.

-- @prelude gate, validate, provisioner, urlencode, json

local MAX_PER_CALL = 15
local CONTACT = "at.happyproto.preferences.contact"

--- The owner's in-use contact address; nil when they have none; and false
--- when their preferences space couldn't be read. Only a record the owner
--- wrote at `self` counts.
local function contact_address(space_uri, owner)
  if type(space_uri) ~= "string" or space_uri == "" then return nil end
  local ok, page = pcall(function()
    return spaces.get(space_uri):records({ collection = CONTACT, limit = 50 })
  end)
  if not ok or type(page) ~= "table" then
    -- The error, never the address (it was never read).
    log.warn("could not read a queued owner's preferences space", { error = tostring(page):sub(1, 200) })
    return false
  end
  for _, r in ipairs(page.records or {}) do
    if r.rkey == "self" and r.author_did == owner and type(r.record) == "table"
      and type(r.record.email) == "string" and r.record.email ~= "" then
      return r.record.email
    end
  end
  return nil
end

function handle(input, ctx)
  local refused = gate_admin(ctx)
  if refused then return refused end
  if not is_uuid(input.idempotencyKey) then
    return failure("InvalidRequest", "idempotencyKey must be a UUID.")
  end

  local status, body = provisioner(ctx, "GET", "/v1/admin/capacity-waits?due=true")
  if status ~= 200 or type(body) ~= "table" or type(body.waits) ~= "table" then
    return provisioner_failure(status, body)
  end

  local result = { sent = 0, noContact = 0, notVerified = 0, unreadable = 0, failed = 0, remaining = 0 }
  local notices = {}
  for _, w in ipairs(body.waits) do
    if type(w) == "table" and is_did(w.did) then
      if #notices >= MAX_PER_CALL then
        result.remaining = result.remaining + 1
      else
        local email = contact_address(w.preferences_space, w.did)
        if email then
          notices[#notices + 1] = { did = w.did, email = email }
        elseif email == false then
          result.unreadable = result.unreadable + 1
        else
          result.noContact = result.noContact + 1
        end
      end
    end
  end
  if #notices == 0 then return result end

  local s, b = provisioner(ctx, "POST", "/v1/admin/capacity-waits/notify",
    { notices = json.to_array(notices) }, input.idempotencyKey)
  if s == 503 and type(b) == "table" and b.error == "EmailNotConfigured" then
    return failure("EmailNotConfigured", "Owner email is switched off.")
  end
  if s ~= 200 or type(b) ~= "table" or type(b.results) ~= "table" then
    return provisioner_failure(s, b)
  end
  for _, r in ipairs(b.results) do
    local outcome = type(r) == "table" and r.outcome or nil
    if outcome == "sent" then
      result.sent = result.sent + 1
    elseif outcome == "not_verified" then
      result.notVerified = result.notVerified + 1
    elseif outcome == "over_budget" then
      result.remaining = result.remaining + 1
      if type(r.retry_at) == "string" then result.retryAt = r.retry_at end
    elseif outcome == "failed" then
      result.failed = result.failed + 1
    end
    -- not_waiting, not_due and held: told already, room went again, or the
    -- account is suspended. Nothing to do.
  end
  return result
end
