-- at.happyproto.server.checkSlug
--
-- Whether a slug is free for a new instance. Customers only.
--
-- The provisioner's own slug rule runs here first (is_slug), so a malformed
-- or reserved slug -- the common case while someone is typing -- is answered
-- without a round trip. A slug that passes is still checked by the
-- provisioner, which also knows the slugs it reserves by configuration and
-- every slug ever taken.

-- @prelude gate, validate, provisioner

function handle(input, ctx)
  local refused = gate_customer(ctx)
  if refused then return refused end

  local slug = input.slug
  if type(slug) ~= "string" or slug == "" then
    return failure("InvalidRequest", "slug is required.")
  end
  local valid, reason = is_slug(slug)
  if not valid then
    return { available = false, reason = reason }
  end

  -- Safe in the path: is_slug admits only [a-z0-9-].
  local status, body = provisioner(ctx, "GET", "/v1/slugs/" .. slug)
  if status ~= 200 or type(body) ~= "table" or type(body.available) ~= "boolean" then
    return provisioner_failure(status, body)
  end
  if body.available then
    return { available = true }
  end
  return { available = false, reason = type(body.reason) == "string" and body.reason or nil }
end
