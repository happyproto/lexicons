# Vendored lexicons

`vendor/lexicons/` holds the upstream `software.release.*` lexicons, copied verbatim from https://release.software. They are deployed to HappyView so the registry can index those records, and are never published by `lexicon-publish`: HappyProto does not own the `software.release` authority, so only the `lexicons/` directory is published.
