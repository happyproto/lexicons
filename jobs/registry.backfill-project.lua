-- @prelude release, authority
--
-- job.run:registry.backfill-project
--
-- Stores the records of one project that its indexers skipped because they
-- arrived before its sidecar. Enqueued by
-- record.index:at.happyproto.registry.project with `{ did, name }` when a
-- sidecar is first stored, or written again after a delete.
--
-- Every software.release record is indexed only while the project has a
-- live sidecar, and a record skipped is not delivered again. Without this,
-- a publisher who wrote their project and releases first and the sidecar
-- last would have a registry project with nothing in it.
--
-- The records are read from the publisher's own PDS, which answers each
-- with its CID: the project by its key, then every manifest and status that
-- names it, and every version and channel keyed `<name>.`. Each is put
-- through exactly the check its indexer applies (the shared
-- `*_record_problem` functions), in the order the indexers need them, so a
-- record stored here is one the indexer would have stored: project,
-- manifests, versions, channels, statuses. Each is stored with
-- `happyview.record.save_local` and the PDS's CID, so the strongRefs between
-- them verify as they would for a record the network delivered, and the
-- registry's own state follows as the indexers would write it: a version's
-- state row, its blob copy and changelog fetch, and a channel's revived
-- mark.
--
-- A record already in the index is left as it is. So the job can run again
-- after a failure part-way, and a sidecar written again stores only what
-- arrived while it was deleted.

local log = require("internal.logging")
local db = require("happyview.db")
local record = require("happyview.record")

--- How many pages of 100 records are read per collection. Far past what a
--- project publishes; a repo with more is stored as far as this reaches, and
--- the run says so.
local MAX_PAGES = 20

--- Records in key order. TIDs sort by time as strings, so this is the order
--- they were written in, which a withdrawal relies on: the status it names
--- comes first.
local function by_rkey(entries)
  table.sort(entries, function(a, b)
    local _, _, ak = parse_uri(a.uri)
    local _, _, bk = parse_uri(b.uri)
    ak, bk = ak or a.uri, bk or b.uri
    if ak ~= bk then return ak < bk end
    return a.uri < b.uri
  end)
  return entries
end

function handle(input, ctx)
  local our_did = happyproto_did(ctx)
  if not our_did then
    error("HAPPYPROTO_DID is unset or malformed, so registry state cannot be written")
  end

  local did, name = input.did, input.name
  if not is_did(did) or not is_project_name(name) then
    return { skipped = "did and name must name a project" }
  end
  -- HappyView's own releases are never a registry project, whatever sidecar
  -- may have been stored before the name was reserved.
  if RESERVED_NAMES[name] then
    return { skipped = "the name " .. name .. " is reserved for HappyView's own releases" }
  end

  if not live_sidecar(our_did, did, name) then
    local state = project_state(our_did, did, name)
    if state and state.sidecarDeleted then
      -- Deleted again before this ran: there is no project to fill.
      return { skipped = "the sidecar was deleted" }
    end
    -- The sidecar's index script queues this before HappyView stores the
    -- sidecar it returned true for, so it may not be there yet. Raised, so
    -- the job is retried once it is.
    error("the sidecar of " .. did .. "/" .. name .. " is not stored yet")
  end

  local project_uri = uri_of(did, PROJECT, name)
  local stored, refused = {}, {}
  local truncated = false

  --- Stores one fetched record at its key, with the CID its PDS gave, unless
  --- the index already holds it. Answers whether it is in the index now.
  local function store(collection, entry, problem)
    if db.get(entry.uri) then return true end
    if problem then
      refused[#refused + 1] = { uri = entry.uri, reason = problem }
      log.info("registry: backfill refused a record", { uri = entry.uri, reason = problem })
      return false
    end
    local _, _, rkey = parse_uri(entry.uri)
    local written = record.save_local(collection, rkey, entry.value, did, { cid = entry.cid })
    -- A record plugin from before `opts.cid` ignores it and stores the row
    -- with no CID, which no strongRef could ever verify: the version or
    -- channel pinning it would be refused for good. Such a row is taken
    -- back out, and the job fails loudly rather than store more of them.
    if type(written) ~= "table" or written.cid ~= entry.cid then
      record.delete_local(entry.uri)
      error("happyview.record stored " .. entry.uri .. " without the CID it was given; "
        .. "the record plugin must support save_local's opts.cid")
    end
    stored[#stored + 1] = entry.uri
    return true
  end

  --- Every record of `collection` in the publisher's repo that `keep`
  --- takes, in key order. A PDS that could not be read raises, so the job
  --- is retried, when asking again could help.
  local function listed(collection, keep)
    local entries, problem, retryable, short = pds_list(did, collection, MAX_PAGES)
    if not entries then
      if retryable then error("could not list " .. collection .. " of " .. did .. ": " .. tostring(problem)) end
      log.warn("registry: backfill could not list records", { did = did, collection = collection, problem = problem })
      return {}
    end
    if short then truncated = true end
    local out = {}
    for _, entry in ipairs(entries) do
      if keep(entry) then out[#out + 1] = entry end
    end
    return by_rkey(out)
  end

  local function keyed(entry)
    local _, _, rkey = parse_uri(entry.uri)
    local key_name, rest = split_rkey(rkey)
    return key_name == name, rest
  end

  -- The project: nothing else can be stored without it.
  if not db.get(project_uri) then
    local fetched, problem, retryable = pds_record(project_uri)
    -- No project in the repo yet: a sidecar written first, as the gateway
    -- writes it, whose project its own indexer will take when it arrives.
    if not fetched and tostring(problem):match("^the PDS answered 40[04]$") then
      return { skipped = "the publisher's repo has no project " .. name .. " yet" }
    end
    if not fetched then
      if retryable then error("could not fetch " .. project_uri .. ": " .. tostring(problem)) end
      return { skipped = problem }
    end
    local entry = { uri = project_uri, cid = fetched.cid, value = fetched.value }
    if not store(PROJECT, entry, project_record_problem(our_did, did, name, entry.value)) then
      return { stored = json.to_array(stored), refused = json.to_array(refused) }
    end
  end

  for _, entry in ipairs(listed(MANIFEST, function(e) return e.value.project == project_uri end)) do
    store(MANIFEST, entry, manifest_record_problem(our_did, did, entry.value))
  end

  for _, entry in ipairs(listed(VERSION, keyed)) do
    local _, version = keyed(entry)
    local fresh = not db.get(entry.uri)
    if store(VERSION, entry, version_record_problem(our_did, did, name, version, entry.value)) and fresh then
      index_version(our_did, did, entry.uri, name, version, entry.value)
    end
  end

  for _, entry in ipairs(listed(CHANNEL, keyed)) do
    local _, channel = keyed(entry)
    local fresh = not db.get(entry.uri)
    if store(CHANNEL, entry, channel_record_problem(our_did, did, name, channel, entry.value)) and fresh then
      index_channel(our_did, did, name, channel)
    end
  end

  local function about_project(e)
    local subject = e.value.subject
    if subject == project_uri then return true end
    local subject_did, collection, rkey = parse_uri(subject)
    return subject_did == did and collection == VERSION and split_rkey(rkey) == name
  end
  for _, entry in ipairs(listed(STATUS, about_project)) do
    store(STATUS, entry, status_record_problem(our_did, did, entry.value))
  end

  log.info("registry: project backfilled", {
    did = did, name = name, stored = #stored, refused = #refused, truncated = truncated,
  })
  return {
    stored = json.to_array(stored),
    refused = json.to_array(refused),
    truncated = truncated or nil,
  }
end
