-- @prelude registry
--
-- xrpc.query:at.happyproto.registry.getProject
--
-- One plugin, by publisher and name. Anonymous: any instance resolves a
-- plugin without an account here.

function handle(input, ctx)
  local our_did = happyproto_did(ctx)
  if not our_did then return failure("NotConfigured", "the registry has no identity configured") end

  local did, handle_name = resolve_actor(input.actor)
  if not did then
    return failure("ActorNotFound", "actor is neither a DID nor a handle that resolves to one")
  end
  if not is_project_name(input.name) then
    return failure("ProjectNotFound", "no project of that name is indexed for that publisher")
  end

  local view = project_view(our_did, did, input.name, handle_name)
  if not view then
    return failure("ProjectNotFound", "no project of that name is indexed for that publisher")
  end
  return view
end
