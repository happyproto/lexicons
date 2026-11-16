-- at.happyproto.actor.setContactEmail
--
-- Set the caller's contact email (HAP-463), in their preferences space, and
-- send a link that proves it. Until the link is opened the address they had
-- stays in use: the new one waits as `pendingEmail`. Setting the address they
-- already have and have proven drops any change waiting; setting one that
-- still waits for its link sends the link again.
--
-- The space is created here if sign-in has not created it yet. The link goes
-- out through the provisioner, which keeps a hash of the address and never
-- the address.
--
-- Customers and staff only, either gate admitting; each fails closed.

-- @prelude gate, validate, provisioner, preferences

function handle(input, ctx)
  if not ctx.caller_did or ctx.caller_did == "" then
    return failure("AuthRequired", "This endpoint requires an authenticated caller.")
  end
  if not is_uuid(input.idempotencyKey) then
    return failure("InvalidRequest", "idempotencyKey must be a UUID.")
  end
  local email = type(input.email) == "string" and input.email:gsub("^%s+", ""):gsub("%s+$", "") or nil
  if not preferences.is_email(email) then
    return failure("InvalidEmail", "Enter an email address, like you@example.com.")
  end
  if gate_customer(ctx) ~= nil and gate_admin(ctx) ~= nil then
    return failure("Forbidden", "Only customers and staff have contact settings.")
  end

  local uri = preferences.space(ctx, true)
  if not uri then return failure("Upstream", "Your preferences could not be saved.") end
  local contact = preferences.read(ctx, uri, preferences.CONTACT)
  if contact == nil then return failure("Upstream", "Your preferences could not be read.") end
  contact = contact or {}

  local current = preferences.is_email(contact.email) and contact.email or nil
  if preferences.same_email(email, current) then
    local proofs, refused = preferences.proven(ctx, current)
    if not proofs then return refused end
    if proofs[current] then
      if contact.pendingEmail ~= nil then
        if not preferences.write(uri, preferences.CONTACT, { email = current, source = contact.source or "owner" }) then
          return failure("Upstream", "Your preferences could not be saved.")
        end
      end
      return { sent = false, verified = true }
    end
  else
    local next_record = current and { email = current, pendingEmail = email, source = contact.source or "owner" }
      or { email = email, source = "owner" }
    if not preferences.write(uri, preferences.CONTACT, next_record) then
      return failure("Upstream", "Your preferences could not be saved.")
    end
  end

  local status, body = provisioner(ctx, "POST", "/v1/account/contact-email/verification",
    { email = email }, input.idempotencyKey)
  if status ~= 200 or type(body) ~= "table" or type(body.expires_at) ~= "string" then
    return contact_failure(status, body)
  end
  return { sent = true, verified = false, expiresAt = body.expires_at }
end
