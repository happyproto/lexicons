-- at.happyproto.server.getJob
--
-- One of the caller's own background jobs, such as the one a change to an
-- instance started. Customers only.
--
-- happyview.jobs' get answers nil unless ctx.caller_did created the job, so
-- another customer's job and a job that does not exist are the same NotFound,
-- word for word. A lookup that raises is NotFound too: it has no other code
-- here, and telling it apart would say nothing the caller can act on.

-- @prelude gate, validate

local jobs = require("happyview.jobs")

function handle(input, ctx)
  local refused = gate_customer(ctx)
  if refused then return refused end

  if not is_uuid(input.id) then
    return failure("InvalidRequest", "id must be a UUID.")
  end

  local ok, job = pcall(jobs.get, input.id)
  if not ok or type(job) ~= "table" then
    return failure("NotFound", "job not found")
  end

  -- Listed field by field: the job's input, creator and timestamps are not
  -- part of the customer shape. An empty table is no report at all.
  local function report(v)
    if type(v) == "table" and next(v) ~= nil then return v end
    return nil
  end
  return {
    job = {
      id = job.id,
      status = job.status,
      progress = report(job.progress),
      result = report(job.result),
      error = type(job.error) == "string" and job.error or nil,
    },
  }
end
