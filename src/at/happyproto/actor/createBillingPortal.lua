-- at.happyproto.actor.createBillingPortal
--
-- Open a Stripe Customer Portal session for the caller's account and hand
-- back its URL. Customers only.
--
-- flow "paymentMethod" goes straight to adding or changing the card: Managed
-- Payments doesn't let the provisioner set a card itself, so this is how a
-- trial without one gets a card. "manage" is the Portal home, for invoices
-- and cancelling. The provisioner sets where the Portal returns to.

-- @prelude gate, validate, provisioner, billing

local FLOWS = { paymentMethod = "payment_method_update", manage = "manage" }

function handle(input, ctx)
  local refused = gate_customer(ctx)
  if refused then return refused end
  if not is_uuid(input.idempotencyKey) then
    return failure("InvalidRequest", "idempotencyKey must be a UUID.")
  end
  local flow = FLOWS[input.flow]
  if not flow then
    return failure("InvalidRequest", "flow must be paymentMethod or manage.")
  end

  local status, body = provisioner(ctx, "POST", "/v1/billing/portal", { flow = flow }, input.idempotencyKey)
  local url = type(body) == "table" and billing.url(body.url) or nil
  if status ~= 200 or not url then
    return billing.failure(status, body)
  end
  return { url = url }
end
