-- at.happyproto.server.getDeployment
--
-- One change to one of the caller's instances, with its steps: what the
-- dashboard shows as a deployment's details and build log. Customers only.
--
-- Ownership is checked here with owned_tenant, and the operation must belong
-- to that instance: an operation of another instance, even the caller's own,
-- is NotFound, so an id cannot be read through the wrong instance.

-- @prelude gate, validate, provisioner, deployments

function handle(input, ctx)
  local refused = gate_customer(ctx)
  if refused then return refused end

  local id, deployment_id = input.id, input.deploymentId
  if not is_uuid(id) then
    return failure("InvalidRequest", "id must be a UUID.")
  end
  if not is_uuid(deployment_id) then
    return failure("InvalidRequest", "deploymentId must be a UUID.")
  end

  local found, missing = owned_tenant(ctx, id)
  if not found then return missing end

  -- Safe in the path: is_uuid admits only hex digits and hyphens.
  local status, body = provisioner(ctx, "GET", "/v1/operations/" .. deployment_id)
  if status == 404 then
    return failure("NotFound", "deployment not found")
  end
  if status ~= 200 or type(body) ~= "table" or type(body.operation) ~= "table" then
    return provisioner_failure(status, body)
  end
  local op = body.operation
  if op.tenant_id ~= id then
    return failure("NotFound", "deployment not found")
  end

  local deployment = public_deployment(op, found.tenant.owner_did)
  deployment.steps = json.to_array(public_steps(op))
  return { deployment = deployment }
end
