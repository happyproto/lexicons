# Vendored lexicons

`vendor/lexicons/` holds the upstream `software.release.*` lexicons, copied verbatim from https://release.software. They are deployed to HappyView so the registry can index those records. HappyProto must not publish them, because it doesn't own the `software.release` authority, so api.happyproto.at's Lexicon Publishing rules have to leave them out.

`software.release.status` is no longer published by the authority. The copy here is the last one it published, kept because the registry still indexes and writes statuses.
