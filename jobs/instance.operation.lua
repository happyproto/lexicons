-- job.run:instance.operation
--
-- Follows one provisioner operation to its end, reporting its status and
-- step as the job's progress, so a customer can watch a change through
-- at.happyproto.server.getJob. Started by every server.* write, with
-- `{ operationId }`, as the customer who asked for the change.
--
-- Inside a job, ctx.caller_did is the job's creator, so the provisioner is
-- asked as that customer and scopes the operation to them.
--
-- The job completes when the operation succeeds and fails, with the
-- operation's error code, when it fails or times out. The job's error is
-- what getJob shows the customer, so the operation's message goes with the
-- code only when that code's message is fixed text in the provisioner;
-- anything else (an agent's or Docker's own words) is logged and replaced.
-- A poll that gets no reply, or a 5xx, is tried again at the next poll. The
-- provisioner gives an operation 10 minutes; after 15 the job gives up.
--
-- Not generated: jobs/ deploys as it is, so this file takes nothing from the
-- prelude and keeps its own small provisioner call.

local http = require("happyview.http")
local json = require("internal.json")
local log = require("internal.logging")

local POLL_SECONDS = 2
local DEADLINE_SECONDS = 15 * 60

-- Operation error codes whose messages the provisioner writes as fixed text,
-- safe to show a customer as they are.
local SAFE_MESSAGES = { Timeout = true, UpgradeRolledBack = true, NoCapacity = true, StepFailed = true }
local FALLBACK_MESSAGE = "The change could not be completed."

--- status, decoded body -- or nil and a message when no reply came back.
local function get_operation(ctx, id)
  local env = ctx.env or {}
  local base, token = env.PROVISIONER_URL, env.PROVISIONER_TOKEN
  if not base or base == "" or not token or token == "" then
    return nil, "provisioner not configured"
  end
  local ok, response = pcall(http.get, (base:gsub("/+$", "")) .. "/v1/operations/" .. id, {
    headers = {
      ["Authorization"] = "Bearer " .. token,
      ["X-Actor-Did"] = ctx.caller_did,
    },
  })
  if not ok then
    return nil, "provisioner unreachable: " .. tostring(response)
  end
  local parsed, decoded = pcall(json.decode, response.body or "")
  return response.status, parsed and decoded or nil
end

--- The operation's last step name, when it has reached one.
local function last_step(op)
  if type(op.steps) ~= "table" then return nil end
  local last = op.steps[#op.steps]
  return type(last) == "table" and type(last.name) == "string" and last.name or nil
end

function handle(input, ctx)
  local id = type(input) == "table" and input.operationId or nil
  -- The id goes into the URL path, so it must be exactly a UUID.
  if type(id) ~= "string" or not id:match("^%x+%-%x+%-%x+%-%x+%-%x+$") then
    error("InvalidRequest: no operation to follow", 0)
  end

  local deadline = os.time() + DEADLINE_SECONDS
  while os.time() < deadline do
    if ctx.job.should_stop() then
      return { status = "stopped" }
    end

    local status, body = get_operation(ctx, id)
    if status == 200 and type(body) == "table" and type(body.operation) == "table" then
      local op = body.operation
      ctx.job.progress({ status = op.status, step = last_step(op) })
      if op.status == "succeeded" then
        return { status = "succeeded" }
      end
      if op.status == "failed" or op.status == "timeout" then
        local code = type(op.error_code) == "string" and op.error_code or "Upstream"
        local message = op.error_message
        if not SAFE_MESSAGES[code] or type(message) ~= "string" or message == "" then
          log.warn("operation failed", { operation = id, code = code, message = message })
          message = FALLBACK_MESSAGE
        end
        error(code .. ": " .. message, 0)
      end
    elseif type(status) == "number" and status >= 400 and status < 500 then
      -- The operation is gone or was never the creator's. Asking again will
      -- not change the answer, and a job that loops here holds one of the
      -- worker's few slots (JOB_WORKER_CONCURRENCY) for 15 minutes.
      local code = type(body) == "table" and type(body.error) == "string" and body.error or "Upstream"
      error(code .. ": the provisioner refused to report the operation", 0)
    else
      -- No reply, a 5xx, or a body that is not an operation: try again.
      log.warn("operation poll failed", { operation = id, status = status, error = type(body) == "string" and body or nil })
    end

    ctx.job.wait(POLL_SECONDS)
  end
  error("Upstream: operation did not finish in time", 0)
end
