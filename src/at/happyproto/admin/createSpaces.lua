-- at.happyproto.admin.createSpaces
--
-- Bootstrap HappyProto's two spaces -- admin and customers -- under
-- HAPPYPROTO_DID, and optionally add staff to the admin space with write
-- access. Only HappyProto's own account may call it.
--
-- Gated on the caller BEING HAPPYPROTO_DID, not on membership of the admin
-- space: the admin space may not exist yet, and this is what creates it.
-- The caller owns both spaces as their creator, so it is never in `staff`'s
-- way: it is already a write member and is skipped like any other.
--
-- Idempotent: a space that exists is kept as it is, and a staff member who
-- already belongs to the admin space is skipped. A second call creates
-- nothing and adds no one. A call that fails part-way has changed only what
-- a retry would change anyway, so the answer to any failure is to call again.
--
-- Member-only policy, as found in HappyView v3.0.0-alpha.4 (unchanged on
-- origin/alpha) and the happyview-spaces v1.0.0 plugin:
--   - A space policy is a `$type`-tagged union (HappyView src/spaces/types.rs,
--     `Policy`): `com.atproto.simplespace.defs#memberListPolicy` admits
--     members only; `#publicPolicy` admits anyone.
--   - The browser's old `mintPolicy: "member-list"` went through
--     src/spaces/simplespace.rs `legacy_policy`, which maps it to MemberList
--     for BOTH the read and the write policy.
--   - happyview.spaces' `create` passes `read_policy`/`write_policy` through
--     untouched (plugins repo, plugins/happyview/spaces/src/lib.rs `create`),
--     and the host deserialises each as that Policy
--     (HappyView src/plugin/host/spaces.rs `create`).
-- An omitted policy already defaults to MemberList (src/spaces/service.rs
-- `create_space`), but both are sent explicitly so a change of default can
-- never open these spaces up. `app_access` and `config` keep their defaults:
-- any client, membership not public.

-- @prelude gate, validate, json

local log = require("internal.logging")

-- Enough for any plausible staff list; a bootstrap that adds more is a
-- mistake, not a team.
local MAX_STAFF = 50

local MEMBER_LIST = { ["$type"] = "com.atproto.simplespace.defs#memberListPolicy" }

local SPACES = {
  {
    field = "adminSpace",
    space_type = ADMIN_SPACE_TYPE,
    display_name = "HappyProto admins",
    description = "Membership of this space grants access to the HappyProto dashboard.",
  },
  {
    field = "customersSpace",
    space_type = CUSTOMERS_SPACE_TYPE,
    display_name = "HappyProto customers",
  },
}

--- `staff` as a list of distinct DIDs, or nil and a failure table. Absent is
--- an empty list. A DID listed twice is added once: the call is idempotent,
--- so a repeat in one call means no more than a repeat across two.
local function staff_list(staff)
  if staff == nil then return {} end
  if type(staff) ~= "table" then
    return nil, failure("InvalidRequest", "staff must be a list of DIDs.")
  end
  -- A table with keys beyond its sequence is an object, not a list.
  for key in pairs(staff) do
    if type(key) ~= "number" or key < 1 or key > #staff or key ~= math.floor(key) then
      return nil, failure("InvalidRequest", "staff must be a list of DIDs.")
    end
  end
  if #staff > MAX_STAFF then
    return nil, failure("InvalidRequest", "staff may list at most " .. MAX_STAFF .. " DIDs.")
  end
  local seen, out = {}, {}
  for i = 1, #staff do
    local did = staff[i]
    if not is_did(did) then
      return nil, failure("InvalidRequest", "every staff entry must be a DID.")
    end
    if not seen[did] then
      seen[did] = true
      out[#out + 1] = did
    end
  end
  return out
end

--- true when the space at `uri` exists, false when it does not, or nil and a
--- failure table when it cannot be read.
local function exists(uri)
  -- pcall: info RAISES with the spaces feature off; it answers nil only for
  -- a space that does not exist.
  local ok, space = pcall(spaces.info, uri)
  if not ok then
    log.warn("could not read a HappyProto space", { uri = uri, error = tostring(space) })
    return nil, failure("Upstream", "HappyProto's spaces could not be read.")
  end
  return type(space) == "table"
end

--- `{uri, created}` for one space, creating it when it is absent, or nil and
--- a failure table.
local function ensure(ctx, spec)
  local uri = happyproto_space(ctx, spec.space_type)
  local found, refused = exists(uri)
  if found == nil then return nil, refused end
  if found then return { uri = uri, created = false } end

  local ok, made = pcall(spaces.create, {
    spaceType = spec.space_type,
    skey = "main",
    display_name = spec.display_name,
    description = spec.description,
    read_policy = MEMBER_LIST,
    write_policy = MEMBER_LIST,
  })
  if not ok then
    -- CONFLICT is a concurrent call that created it first: the space exists,
    -- which is all this call wanted.
    local again = exists(uri)
    if again then return { uri = uri, created = false } end
    log.warn("could not create a HappyProto space", { uri = uri, error = tostring(made) })
    return nil, failure("Upstream", "HappyProto's spaces could not be created.")
  end

  -- HappyView anchors a new space on the instance's own DID when the instance
  -- publishes a service identity, and on the creator's DID only when it does
  -- not (src/spaces/service.rs `space_authority_for_new_space`). Anchored on
  -- the instance, the space is not at the uri the gates derive, so it would
  -- grant nothing: remove it and say why rather than report success.
  if type(made) ~= "table" or made.uri ~= uri then
    local stray = type(made) == "table" and made.uri or nil
    local removed = stray ~= nil and pcall(function()
      return spaces.get(stray):delete()
    end)
    log.warn("a HappyProto space was created at the wrong uri", {
      expected = uri, created = stray, removed = removed,
    })
    return nil, failure("Upstream", "This instance creates spaces under its own DID, not HAPPYPROTO_DID, so the gates could never find them. "
      .. (removed and "The space it made was removed." or "The space it made could not be removed."))
  end
  return { uri = uri, created = true }
end

function handle(input, ctx)
  local refused = gate_owner(ctx)
  if refused then return refused end

  -- Validated before anything is created, so a bad list changes nothing.
  local staff, invalid = staff_list(input.staff)
  if not staff then return invalid end

  local out = {}
  for _, spec in ipairs(SPACES) do
    local space, failed = ensure(ctx, spec)
    if not space then return failed end
    out[spec.field] = space
  end

  local admin = spaces.get(out.adminSpace.uri)
  local added = {}
  for _, did in ipairs(staff) do
    -- pcall: is_member and add_member RAISE on a host failure; add_member
    -- also raises CONFLICT for an existing member.
    local ok, member = pcall(function() return admin:is_member(did) end)
    if not ok then
      log.warn("could not read the admin space's members", { did = did, error = tostring(member) })
      return failure("Upstream", "The admin space's members could not be read.")
    end
    if not member then
      local wrote, err = pcall(function()
        return admin:add_member({ did = did, access = "write" })
      end)
      if wrote then
        added[#added + 1] = did
      else
        err = tostring(err)
        -- CONFLICT: a concurrent call added them first.
        if not err:find("CONFLICT", 1, true) then
          log.warn("could not add a staff member", { did = did, error = err })
          return failure("Upstream", "The admin space's members could not be changed.")
        end
      end
    end
  end

  out.staffAdded = json.to_array(added)
  return out
end
