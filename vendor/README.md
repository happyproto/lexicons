# Vendored lexicons

`vendor/lexicons/` holds the upstream `software.release.*` lexicons, copied verbatim from https://release.software. They are deployed to HappyView so the registry can index those records, and are never published by `lexicon-publish`: HappyProto does not own the `software.release` authority, so only the `lexicons/` directory is published.

`software.release.status` is no longer published by the authority. The copy here is the last one it published, kept because the registry still indexes and writes statuses.
