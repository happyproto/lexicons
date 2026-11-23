-- at.happyproto.actor.signUp
--
-- Join HappyProto in the open beta (HAP-509): accept the beta terms, and
-- become a customer by joining the customers space through the standing
-- signup invite (see the `signup` prelude block). Not gated, since the caller
-- is by definition not a customer yet; signup must be open, and the
-- provisioner decides whether this account may join (not suspended, and not
-- past the signup breaker).
--
-- The provisioner is asked first, so a refused signup joins nothing. A
-- caller who is already a customer has the terms recorded and joins nothing.
-- A join that fails after the provisioner agreed is safe to retry with the
-- same idempotencyKey: the provisioner never pauses an account that has
-- signed up before.

-- @prelude failure, validate, access, authority, signup, provisioner, json

local spaces = require("happyview.spaces")

local function terms_body(input)
  return { terms_version = input.termsVersion, text_version = input.textVersion, text = input.text }
end

--- A refusal of the signup or terms route as this endpoint's errors.
local function signup_failure(status, body)
  local code = type(body) == "table" and body.error or nil
  local message = type(body) == "table" and type(body.message) == "string" and body.message or nil
  if status == 400 and (code == "TermsRequired" or code == "TermsOutdated") and message then
    return failure(code, message)
  end
  if status == 403 and code == "AccountSuspended" then
    return failure("AccountSuspended", "This account is suspended.")
  end
  if status == 429 and code == "SignupsPaused" then
    return failure("SignupsPaused", "Signups are paused for now. Try again later.")
  end
  return provisioner_failure(status, body)
end

function handle(input, ctx)
  local caller = ctx.caller_did
  if not caller or caller == "" then
    return failure("AuthRequired", "This endpoint requires an authenticated caller.")
  end
  if not is_uuid(input.idempotencyKey) then
    return failure("InvalidRequest", "idempotencyKey must be a UUID.")
  end
  if type(input.termsVersion) ~= "string" or type(input.textVersion) ~= "string"
    or type(input.text) ~= "string" then
    return failure("InvalidRequest", "termsVersion, textVersion and text are required.")
  end

  local token = signup_invite(ctx)
  if not token then
    return failure("SignupClosed", "Signup is closed.")
  end
  local uri = happyproto_space(ctx, CUSTOMERS_SPACE_TYPE)
  if not uri then
    return failure("Upstream", "customers space not configured")
  end

  local ok, access = pcall(function()
    return spaces.get(uri):access(caller)
  end)
  if not ok then
    return failure("Upstream", "The customers space could not be read.")
  end

  if MEMBER_ACCESS[access] then
    local status, body = provisioner(ctx, "POST", "/v1/account/terms", terms_body(input), input.idempotencyKey)
    if status ~= 200 or type(body) ~= "table" or type(body.terms_version) ~= "string" then
      return signup_failure(status, body)
    end
    return { isCustomer = true, joined = false, termsVersion = body.terms_version }
  end

  local status, body = provisioner(ctx, "POST", "/v1/account/signup", terms_body(input), input.idempotencyKey)
  if status ~= 200 or type(body) ~= "table" or type(body.terms_version) ~= "string" then
    return signup_failure(status, body)
  end

  local joined_ok, space = pcall(function()
    return spaces.accept_invite({ token = token })
  end)
  if not joined_ok then
    if tostring(space):lower():find("already a member", 1, true) then
      return { isCustomer = true, joined = false, termsVersion = body.terms_version }
    end
    -- Expired, used up, revoked or unknown: the standing invite is
    -- misconfigured, which only staff can fix. Never the caller's fault.
    log.warn("the standing signup invite was refused", { error = tostring(space):sub(1, 200) })
    return failure("Upstream", "Signup could not be completed.")
  end
  if type(space) ~= "table" or space.uri ~= uri then
    log.warn("the standing signup invite is not for the customers space", { did = caller })
    return failure("Upstream", "Signup could not be completed.")
  end
  return { isCustomer = true, joined = true, termsVersion = body.terms_version }
end
