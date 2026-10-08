-- at.happyproto.admin.listJobs
--
-- Background jobs across every user, newest first. Staff only.
--
-- happyview.jobs' list_any never carries a job's session fields, and each job
-- is still copied field by field, so its input -- which can hold whatever a
-- script enqueued -- stays out too. A job's error is shown as the job wrote
-- it: staff may see raw text that customers never do.

-- @prelude gate, json

local jobs = require("happyview.jobs")

local STATUSES = {
  pending = true, running = true, paused = true, pausing = true,
  cancelling = true, completed = true, failed = true, cancelled = true,
}

-- The jobs still in play, when no status is asked for.
local ACTIVE = "pending,running,pausing,cancelling"

--- The statuses as an array, or nil when one is empty or unknown. Spaces
--- around each are ignored, so "failed, completed" reads as it looks. So is
--- `+`: HappyView does not decode it to a space in a query string, though
--- form encoding (URLSearchParams included) sends a space as one, and no
--- status contains it.
local function statuses(text)
  local out = {}
  for raw in (text .. ","):gmatch("([^,]*),") do
    local part = raw:match("^[%s+]*(.-)[%s+]*$")
    if not STATUSES[part] then return nil end
    out[#out + 1] = part
  end
  return out
end

function handle(input, ctx)
  local refused = gate_admin(ctx)
  if refused then return refused end

  local status = statuses(type(input.status) == "string" and input.status or ACTIVE)
  if not status then
    return failure("InvalidRequest", "status must be a comma-separated list of job statuses.")
  end

  -- The plugin decodes limit as a whole number, so it goes as a Lua integer,
  -- never 50.0.
  local limit = 50
  if input.limit ~= nil then
    limit = math.tointeger(tonumber(input.limit))
    if not limit or limit < 1 or limit > 200 then
      return failure("InvalidRequest", "limit must be a whole number from 1 to 200.")
    end
  end

  -- Always a table with keys: list_any refuses anything else, and an empty
  -- Lua table could go as a JSON array.
  local opts = { status = status, limit = limit }
  if type(input.jobType) == "string" and input.jobType ~= "" then
    opts.job_type = input.jobType
  end

  -- pcall: list_any RAISES on a host or database failure.
  local ok, found = pcall(jobs.list_any, opts)
  if not ok or type(found) ~= "table" then
    return failure("Upstream", "The jobs could not be read.")
  end

  -- An empty table is no report at all.
  local function report(v)
    if type(v) == "table" and next(v) ~= nil then return v end
    return nil
  end
  local out = {}
  for _, job in ipairs(found) do
    out[#out + 1] = {
      id = job.id,
      status = job.status,
      progress = report(job.progress),
      result = report(job.result),
      error = type(job.error) == "string" and job.error or nil,
      jobType = job.job_type,
      createdBy = job.created_by,
      createdAt = job.created_at,
      startedAt = job.started_at,
      completedAt = job.completed_at,
    }
  end
  return { jobs = json.to_array(out) }
end
