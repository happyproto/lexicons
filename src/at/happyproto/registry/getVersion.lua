-- @prelude registry
--
-- xrpc.query:at.happyproto.registry.getVersion
--
-- One version of a plugin, whatever its lifecycle state or availability: a
-- version already installed must stay resolvable by its exact version after
-- it is retired or deleted at its source.

function handle(input, ctx)
  local our_did = happyproto_did(ctx)
  if not our_did then return failure("NotConfigured", "the registry has no identity configured") end

  local did, name, version = input.did, input.name, input.version
  local view = is_did(did) and is_project_name(name) and is_release_version(version)
    and version_view(our_did, did, name, version, { refresh = true }) or nil
  if not view then
    return failure("VersionNotFound", "no version of that project is indexed at that version")
  end
  return view
end
