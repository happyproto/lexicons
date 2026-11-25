-- at.happyproto.billing.createCheckout
--
-- Start a Stripe Checkout for the caller's subscription and hand back its URL.
-- Customers only.
--
-- The provisioner builds the Checkout, including where Stripe sends the
-- caller back to (the dashboard's own address, from its configuration), so
-- nothing the caller sends sets the return. Without withCard, an account
-- that hasn't had a trial gets one without a card; withCard takes a card now
-- and skips the trial pool. Whether the account gets the closed beta's later
-- start is the provisioner's call, from the account, never an input.

-- @prelude gate, validate, provisioner, billing

function handle(input, ctx)
  local refused = gate_customer(ctx)
  if refused then return refused end
  if not is_uuid(input.idempotencyKey) then
    return failure("InvalidRequest", "idempotencyKey must be a UUID.")
  end
  if type(input.plan) ~= "string" or input.plan == "" or #input.plan > 64 then
    return failure("InvalidRequest", "plan is required.")
  end
  if input.withCard ~= nil and type(input.withCard) ~= "boolean" then
    return failure("InvalidRequest", "withCard must be true or false.")
  end
  local code = nil
  if input.code ~= nil then
    if type(input.code) ~= "string" or input.code == "" or #input.code > 64 then
      return failure("InvalidRequest", "code must be 1 to 64 characters.")
    end
    code = input.code
  end

  local status, body = provisioner(ctx, "POST", "/v1/billing/checkout", {
    plan = input.plan,
    code = code,
    with_card = input.withCard == true,
  }, input.idempotencyKey)
  local url = type(body) == "table" and billing.url(ctx, body.url) or nil
  if status ~= 200 or not url then
    return billing.failure(status, body)
  end
  return { url = url, expiresAt = billing.time(body.expires_at) }
end
