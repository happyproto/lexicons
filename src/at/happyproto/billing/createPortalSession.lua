-- at.happyproto.billing.createPortalSession
--
-- Open a Stripe Customer Portal session for the caller's account and hand
-- back its URL. Customers only.
--
-- flow "paymentMethod" goes straight to adding or changing the card: Managed
-- Payments doesn't let the provisioner set a card itself, so this is how a
-- trial without one gets a card. Without a flow it's the Portal home, for
-- invoices and cancelling. The provisioner sets where the Portal returns to.

-- @prelude gate, validate, provisioner, billing

function handle(input, ctx)
  local refused = gate_customer(ctx)
  if refused then return refused end
  if not is_uuid(input.idempotencyKey) then
    return failure("InvalidRequest", "idempotencyKey must be a UUID.")
  end
  if input.flow ~= nil and input.flow ~= "paymentMethod" then
    return failure("InvalidRequest", "flow must be paymentMethod, or absent.")
  end
  local request = {}
  if input.flow == "paymentMethod" then
    request.flow = "payment_method_update"
  end

  local status, body = provisioner(ctx, "POST", "/v1/billing/portal", request, input.idempotencyKey)
  local url = type(body) == "table" and billing.url(ctx, body.url) or nil
  if status ~= 200 or not url then
    return billing.failure(status, body)
  end
  return { url = url }
end
