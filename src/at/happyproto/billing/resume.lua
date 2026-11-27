-- at.happyproto.billing.resume
--
-- Ask the provisioner to resume the caller's paused trial: an owner's retry
-- once a card is on file (the card appearing also triggers it on its own).
-- Customers only. The provisioner re-checks the card, then asks Stripe; the
-- subscription stays paused until the first payment clears, and the reply
-- is the account's billing as it stands. No card yet is CardRequired.

-- @prelude gate, validate, provisioner, billing

function handle(input, ctx)
  local refused = gate_customer(ctx)
  if refused then return refused end
  if not is_uuid(input.idempotencyKey) then
    return failure("InvalidRequest", "idempotencyKey must be a UUID.")
  end

  local status, body = provisioner(ctx, "POST", "/v1/billing/resume", {}, input.idempotencyKey)
  local state = status == 200 and billing.public(body) or nil
  if not state then
    return billing.failure(status, body)
  end
  return { billing = state }
end
