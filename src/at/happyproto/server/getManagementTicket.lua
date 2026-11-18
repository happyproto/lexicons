-- at.happyproto.server.getManagementTicket
--
-- A 60-second ticket that lets the dashboard call one of the caller's
-- instances' admin API as the caller (HAP-472). Customers only.
--
-- A procedure, not a query: a query script runs without the caller's
-- session, and the caller assertion needs it. The assertion is HappyView's
-- own statement of who is calling and with which DPoP key; the provisioner
-- takes the actor from it, checks ownership itself (staff get tickets only
-- for their own instances), and binds the ticket to that key. So nothing
-- here decides who the ticket is for.

-- @prelude gate, validate, provisioner

function handle(input, ctx)
  local refused = gate_customer(ctx)
  if refused then return refused end

  local id = input.instance
  if not is_uuid(id) then
    return failure("InvalidRequest", "instance must be a UUID.")
  end

  local audience = (ctx.env or {}).PROVISIONER_AUDIENCE
  if not audience or audience == "" or not ctx.caller_assertion then
    return failure("Upstream", "Management tickets are not configured.")
  end
  local assertion, why = ctx.caller_assertion(audience)
  if not assertion then
    log.warn("no caller assertion", { reason = why })
    return failure("Unavailable", "Sign in again to manage this instance.")
  end

  -- Safe in the path: is_uuid admits only hex digits and hyphens.
  local body, refusal = management_ticket(ctx, id, assertion)
  if not body then return refusal end
  return {
    ticket = body.ticket,
    expiresAt = body.expires_at,
    audience = body.audience,
    url = body.url,
  }
end
