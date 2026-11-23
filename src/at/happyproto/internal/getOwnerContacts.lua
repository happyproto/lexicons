-- at.happyproto.internal.getOwnerContacts
--
-- The contact email and maintenance setting in each of the preferences
-- spaces named (HAP-463 phase 2), for the provisioner's maintenance-notice
-- sender. Only the provisioner may call it: it signs a service-auth token as
-- PROVISIONER_DID, which HappyView accepts here only through a `specific`
-- service entry listing this method, and gate_provisioner admits that DID
-- alone. Without the variable, nobody gets in.
--
-- The provisioner names the spaces from its own `accounts.preferences_space`,
-- so a space is read only when it has a uri on file; it checks the creator
-- answered here against the owner it asked about, and mails an address only
-- when its own proofs say the address was confirmed. So nothing here decides
-- who is mailed. A record counts only when the space's creator wrote it, the
-- same rule the owner's own reads follow.
--
-- Only `email` is answered, never `pendingEmail`: until its link is opened, a
-- new address is not the one in use. Nothing here logs an address.

-- @prelude gate, validate, preferences

local MAX_SPACES = 50

--- The creator's own record at `collection`/self: the record, false when
--- there is none, or nil when the space can't be read.
local function own_record(uri, collection, creator)
  local ok, page = pcall(function()
    return spaces.get(uri):records({ collection = collection, limit = 50 })
  end)
  if not ok or type(page) ~= "table" then return nil end
  for _, r in ipairs(page.records or {}) do
    if r.rkey == preferences.RKEY and r.author_did == creator and type(r.record) == "table" then
      return r.record
    end
  end
  return false
end

--- One space's answer.
local function contact_of(uri)
  local ok, info = pcall(spaces.info, uri)
  if not ok then return { space = uri, status = "unreadable" } end
  -- happyview.spaces names the type `spaceType`; older builds said
  -- `type_nsid`.
  local space_type = type(info) == "table" and (info.spaceType or info.type_nsid) or nil
  if type(info) ~= "table" or space_type ~= preferences.TYPE or info.skey ~= preferences.SKEY
    or not is_did(info.creator_did) then
    return { space = uri, status = "missing" }
  end
  local creator = info.creator_did
  local contact = own_record(uri, preferences.CONTACT, creator)
  local notices = own_record(uri, preferences.NOTICES, creator)
  if contact == nil or notices == nil then
    return { space = uri, status = "unreadable" }
  end
  local out = {
    space = uri,
    status = "ok",
    creator = creator,
    maintenance = not (notices and notices.maintenance == false),
  }
  if contact and preferences.is_email(contact.email) then out.email = contact.email end
  return out
end

function handle(input, ctx)
  local refused = gate_provisioner(ctx)
  if refused then return refused end

  local asked = input.spaces
  if type(asked) == "string" then asked = { asked } end
  if type(asked) ~= "table" or #asked == 0 or #asked > MAX_SPACES then
    return failure("InvalidRequest", "spaces must name 1 to " .. MAX_SPACES .. " preferences spaces.")
  end
  local seen, uris = {}, {}
  for _, uri in ipairs(asked) do
    if type(uri) ~= "string" or not is_space_of_type(uri, preferences.TYPE)
      or uri:match("/([^/]+)$") ~= preferences.SKEY then
      return failure("InvalidRequest", "Each of spaces must be a preferences space uri.")
    end
    if not seen[uri] then
      seen[uri] = true
      uris[#uris + 1] = uri
    end
  end

  local contacts, unreadable = {}, 0
  for _, uri in ipairs(uris) do
    local c = contact_of(uri)
    if c.status == "unreadable" then unreadable = unreadable + 1 end
    contacts[#contacts + 1] = c
  end
  if unreadable > 0 then
    log.warn("some preferences spaces could not be read", { asked = #uris, unreadable = unreadable })
  end
  return { contacts = json.to_array(contacts) }
end
