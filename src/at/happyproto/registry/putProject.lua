-- at.happyproto.registry.putProject
--
-- Create or update a plugin project in the caller's repo: its
-- software.release.project, the site.standard.publication that holds its
-- display name, and the at.happyproto.registry.project sidecar that makes it
-- a plugin.
--
-- Records are written one at a time, so the order is what keeps the index
-- whole: the publication first, then the sidecar that pins it, then the
-- project, which the indexer takes only once its sidecar is there.
--
-- Every write is a put, which creates a record or replaces it. A call that
-- failed part-way left some of the three behind, and a record the indexer
-- once refused is in the repo but not the index; a create at either's key
-- would fail, where a put takes the key over.
--
-- On an update, the publication is put before the sidecar because the
-- sidecar pins the publication's new CID, which exists only once it is
-- written. The swap guards the sidecar alone, so two concurrent updates
-- can both replace the publication; the one that loses the sidecar swap is
-- refused with InvalidSwap and leaves the publication it wrote unpinned.
-- The registry caches only the publication the sidecar pins, so the loser's
-- display name is not shown, and reading the project again and repeating
-- the call puts it right.
--
-- The input is checked with the rules the indexer applies, so a project the
-- registry would skip is refused here, where the publisher can still fix it.

-- @prelude registry

local db = require("happyview.db")
local log = require("internal.logging")

local function publication_problem(p)
  if type(p) ~= "table" then return "publication is missing" end
  if p.name == "" then return "publication.name is required" end
  local problem = text_problem(p.name, "publication.name", 64, 640)
  if problem then return problem end
  if p.description ~= nil then
    problem = text_problem(p.description, "publication.description", 300, 3000)
    if problem then return problem end
  end
  if p.icon ~= nil then
    -- The registry copies an icon only as one of the raster types it serves,
    -- so any other would be dropped from the listing without a word.
    problem = blob_problem(p.icon, "publication.icon", IMAGE_TYPES, MAX_IMAGE)
    if problem then return problem end
  end
  return nil
end

local function publication_record(did, name, p)
  return {
    ["$type"] = PUBLICATION,
    name = p.name,
    url = plugin_page_url(did, name),
    description = p.description,
    icon = p.icon,
  }
end

--- Only the fields the sidecar lexicon declares are carried over, so nothing
--- else a client sends ends up in the publisher's repo.
local function sidecar_record(did, name, project, pin)
  return {
    ["$type"] = SIDECAR,
    project = uri_of(did, PROJECT, name),
    publication = pin,
    pluginType = project.pluginType,
    keywords = project.keywords,
    authors = project.authors,
    security = project.security,
  }
end

function handle(input, ctx)
  local our_did = happyproto_did(ctx)
  if not our_did then
    return failure("NotConfigured", "the registry has no identity configured")
  end

  local name = input.name
  if not is_project_name(name) then
    return failure("InvalidRecord", "name must be 1 to 64 lowercase letters, digits and interior hyphens")
  end
  local problem = publication_problem(input.publication)
  if problem then return failure("InvalidRecord", problem) end
  if type(input.project) ~= "table" then
    return failure("InvalidRecord", "project is missing")
  end

  -- The sidecar is checked as the record it will be. Without a caller there
  -- is no repo yet, so the registry's own DID stands in for the parts that
  -- only depend on whose repo it is.
  local caller = ctx.caller_did
  local owner = is_did(caller) and caller or our_did
  problem = sidecar_problem(
    sidecar_record(owner, name, input.project, { uri = uri_of(owner, PUBLICATION, name), cid = "unwritten" }),
    owner, name
  )
  if problem then return failure("InvalidRecord", problem) end

  local project_uri, sidecar_uri, publication_uri
  local project_row, sidecar_row
  if caller then
    project_uri = uri_of(caller, PROJECT, name)
    sidecar_uri = uri_of(caller, SIDECAR, name)
    publication_uri = uri_of(caller, PUBLICATION, name)
    project_row, sidecar_row = db.get(project_uri), db.get(sidecar_uri)

    -- Every release must be of the sidecar's type, and the indexer keeps a
    -- sidecar's first type, so a change could only leave the two apart.
    local stored_type = sidecar_row and (sidecar_row.record or {}).pluginType
    if stored_type and stored_type ~= input.project.pluginType then
      return failure("InvalidRecord", "pluginType cannot change once published; it is " .. tostring(stored_type))
    end
    -- Checked before anything is written, so a stale read never leaves a
    -- new publication behind that no sidecar pins.
    if input.swapCid ~= nil and (not sidecar_row or sidecar_row.cid ~= input.swapCid) then
      return failure("InvalidSwap", "the project changed since it was read; read it again")
    end
  end

  if input.validateOnly then
    return { valid = true }
  end

  if not caller then
    return failure(
      "AuthRequired",
      "your identity could not be determined, so there is no repo to write to"
    )
  end

  local function refused(what, err)
    if err:find("InvalidSwap", 1, true) then
      return failure("InvalidSwap", "the project changed since it was read; read it again")
    end
    log.warn("registry: putProject could not write the " .. what, { did = caller, name = name, error = err })
    return failure(
      "Upstream",
      "the " .. what .. " could not be written to your repo; what was written before it stays, and the same call can be made again"
    )
  end

  local created = project_row == nil

  local publication, err = caller_write("put", publication_uri,
    publication_record(caller, name, input.publication), {})
  if not publication then return refused("publication", err) end

  local sidecar
  sidecar, err = caller_write("put", sidecar_uri,
    sidecar_record(caller, name, input.project, publication), { swap_cid = input.swapCid })
  if not sidecar then return refused("plugin sidecar", err) end

  -- The project record is never changed once the index holds it. One only
  -- in the repo is taken over as `{name}`, the only field it may carry here,
  -- since renames are not made through the gateway.
  local project
  if created then
    project, err = caller_write("put", project_uri, { ["$type"] = PROJECT, name = name }, {})
    if not project then return refused("project", err) end
  else
    project = { uri = project_row.uri, cid = project_row.cid }
  end

  return {
    valid = true,
    created = created,
    project = project,
    publication = publication,
    sidecar = sidecar,
  }
end
