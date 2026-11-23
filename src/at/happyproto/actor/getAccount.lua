-- at.happyproto.actor.getAccount
--
-- Is the caller a customer, and how many instances do they have of how many
-- allowed? Any signed-in caller: this is how someone not yet invited finds
-- that out, so it is not customer-gated. It reports the customer gate's
-- answer instead of acting on it.
--
-- Only a customer costs a provisioner call; anyone else gets zeros.

-- @prelude gate, provisioner, json

function handle(input, ctx)
  if not ctx.caller_did or ctx.caller_did == "" then
    return failure("AuthRequired", "This endpoint requires an authenticated caller.")
  end

  -- The gate's own verdict, so this can never disagree with what the
  -- customer endpoints decide. It fails closed: no customers space, or one
  -- that cannot be read, reports "not a customer".
  if gate_customer(ctx) ~= nil then
    return { isCustomer = false, instanceCount = 0, instanceLimit = 0 }
  end

  local status, body = provisioner(ctx, "GET", "/v1/account")
  if status ~= 200 or type(body) ~= "table"
    or type(body.instance_count) ~= "number" or type(body.instance_limit) ~= "number" then
    return provisioner_failure(status, body)
  end
  local wait = nil
  local w = body.capacity_wait
  if type(w) == "table" and type(w.plan) == "string" and type(w.queued_at) == "string" then
    wait = {
      plan = w.plan,
      queuedAt = w.queued_at,
      notified = type(w.notified_at) == "string",
      room = w.room == true,
    }
  end
  local deleted = {}
  if type(body.deleted_instances) == "table" then
    for _, d in ipairs(body.deleted_instances) do
      if type(d) == "table" and type(d.id) == "string" and type(d.slug) == "string"
        and type(d.deleted_at) == "string" and type(d.purge_after) == "string" then
        deleted[#deleted + 1] = { id = d.id, slug = d.slug, deletedAt = d.deleted_at, purgeAfter = d.purge_after }
      end
    end
  end
  return {
    isCustomer = true,
    instanceCount = body.instance_count,
    instanceLimit = body.instance_limit,
    -- Fields a provisioner from before the open beta leaves out.
    deletedInstanceCount = type(body.deleted_instance_count) == "number" and body.deleted_instance_count or 0,
    deletedInstances = json.to_array(deleted),
    suspended = body.suspended == true,
    capacityWait = wait,
  }
end
