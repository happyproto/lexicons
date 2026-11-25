-- at.happyproto.actor.confirmCheckout
--
-- Confirm a Checkout the caller has come back from. Customers only.
--
-- The provisioner fetches the Checkout Session from Stripe itself and checks
-- it belongs to the caller's account, so the session id is only a lookup
-- key: a made-up or another account's id confirms nothing. The webhook makes
-- the same change later; this makes it current for the page the caller lands
-- on.

-- @prelude gate, validate, provisioner, billing

function handle(input, ctx)
  local refused = gate_customer(ctx)
  if refused then return refused end
  if not is_uuid(input.idempotencyKey) then
    return failure("InvalidRequest", "idempotencyKey must be a UUID.")
  end
  local id = input.sessionId
  if type(id) ~= "string" or #id > 255 or not id:match("^cs_[%w_]+$") then
    return failure("InvalidRequest", "sessionId must be a Checkout Session id.")
  end

  local status, body = provisioner(ctx, "POST", "/v1/billing/checkout/confirm", {
    session_id = id,
  }, input.idempotencyKey)
  local state = type(body) == "table" and billing.public(body.billing) or nil
  if status ~= 200 or not state then
    return billing.failure(status, body)
  end
  return { billing = state }
end
