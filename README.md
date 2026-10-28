# HappyProto lexicons

The `com.happyproto.*` lexicons and the Lua scripts that back them, deployed
to HappyProto's HappyView instance at **https://api.happyproto.at**.

This is how the dashboard gets data. HappyView is the authenticated API in
front of ClickHouse: a lexicon defines an XRPC method, and a Lua script
answers it — querying ClickHouse over the container network, with the caller's
DID in scope for authorization.

## Layout

Everything is discovered by directory layout. There is no manifest.

| Directory          | Pattern     | Becomes                                                  |
| ------------------ | ----------- | -------------------------------------------------------- |
| `lexicons/`        | `**/*.json` | uploaded and published lexicons (NSID from the `id` field) |
| `accounts/<handle>/` | `**/*.json` | published to another account's repo, never uploaded (see [Other accounts](#other-accounts)) |
| `vendor/lexicons/` | `**/*.json` | uploaded, never published (see [Vendored lexicons](#vendored-lexicons)) |
| `lua/`             | `**/*.lua`  | `xrpc.query` / `xrpc.procedure` / `record.index`         |
| `lua/jobs/`        | `*.lua`     | `job.run:<type>`, generated from `jobs/`                 |
| `labelers/`        | `**/*.lua`  | `labeler.apply:<nsid>`                                   |

### `lua/` is generated

Scripts are **authored in `src/`** (`src/at/` for HappyProto's own lexicons,
`src/software/` for the `software.release.*` records the registry indexes) and
generated into `lua/` by `bun run gen`; jobs are authored in `jobs/` and
generated into `lua/jobs/`. `lua/` is build output and is not in version
control.

Discovery still works on directory layout — `src/at/happyproto/fleet/getSignals.lua`
becomes `lua/at/happyproto/fleet/getSignals.lua` becomes
`at.happyproto.fleet.getSignals` — but the deployed file is generated, and the
shared gates and helpers live once in `src/shared/prelude.lua` instead of being
copied by hand into every script.

The sandbox's `require` loads only HappyView's own `internal.*` modules and
installed `happyview.*` library plugins, never a sibling file, so sharing code
at runtime is impossible; the duplication has to be resolved at build time.
Each source declares which prelude blocks it needs:

```lua
-- @prelude gate, clickhouse
```

| Block | Provides | Implies |
| --- | --- | --- |
| `json` | `json`, from `internal.json` | — |
| `failure` | `failure(name, message)` | — |
| `validate` | `is_uuid(s)`, `is_did(s)`, `is_slug(s)` | — |
| `access` | `MEMBER_ACCESS`, the space access levels that admit | — |
| `authority` | `happyproto_did(ctx)`, `happyproto_space(ctx, type)`, `ADMIN_SPACE_TYPE`, `CUSTOMERS_SPACE_TYPE` | `validate` |
| `gate` | `gate_admin(ctx)`, `gate_customer(ctx)`, `gate_owner(ctx)` | `failure`, `access`, `validate`, `authority` |
| `urlencode` | `url_encode(s)`, for query values and path segments, DIDs included | — |
| `clickhouse` | `query(ctx, sql, params)` | `json`, `failure`, `urlencode` |
| `provisioner` | `provisioner(ctx, method, path, body?, key?)`, `provisioner_failure(status, body)`, `owned_tenant(ctx, id)` | `json`, `failure` |
| `instance` | `public_instance(t, op)`, `admin_instance(t, op, host_name)`, `instance_state(t, op)`, `public_operation(op)` | `json` |
| `jobs` | `follow_operation(op)`, which starts the `instance.operation` job as the caller | `failure` |
| `release` | the record grammar and validators (`artifact_problem`, `sidecar_problem`, …), `prior_row`, `pds_get`, `copy_blob`, `fetch_changelog`, `lifecycle(statuses, project_statuses)` | `validate`, `json`, `urlencode` |
| `registry` | what the gateway and the read API share: `resolve_actor`, `caller_write`, `project_view`, `version_view`, paging | `release`, `authority`, `validate`, `failure`, `json`, `urlencode` |

Blocks are emitted in **prelude file order**, never directive order, because a
Lua local must be declared before any function closing over it.

Each gate returns nil when the caller may proceed and a failure table
otherwise, and fails closed: no caller, an unset or malformed `HAPPYPROTO_DID`,
or a space that cannot be read all refuse. A gated handler opens with it:

```lua
function handle(input, ctx)
  local refused = gate_admin(ctx)
  if refused then return refused end
  -- ...
end
```

`gate` is deliberately separable from `failure`: `actor.getProfile` needs the
failure helper but must **not** be admin-gated. It is the endpoint that tells a
caller whether they are a member, so gating it on membership would be circular.
For the caller only, its output reports `isMember` and `access` (admin-space
membership) and `isCustomer` (customers-space membership). `isCustomer` is
`gate_customer(ctx) == nil`, the verdict the customer endpoints apply, so the
two cannot disagree; it never touches the provisioner and fails closed.

`gate_owner` admits exactly `HAPPYPROTO_DID` and nobody else. Only
`admin.createSpaces` takes it, because that endpoint creates the admin space
and so cannot be gated on membership of it.

`bun test` checks that every script has a paired lexicon and defines
`handle(input, ctx)`; that nothing reads `ctx` or `env` at file scope; that
every `fleet.*` and `admin.*` handler opens with `gate_admin(ctx)` and every
`server.*` handler with `gate_customer(ctx)`, except `admin.createSpaces`,
which opens with `gate_owner(ctx)` in the same idiom; that every procedure writing
through the provisioner forwards `input.idempotencyKey`; that every lexicon
declares each error its script can return; that no source re-declares a
prelude helper or interpolates a caller value into SQL; and that all generated
output parses under `luac -p`. `scripts/prelude.test.ts` runs the prelude
itself under Lua 5.4 against stub modules, so it needs `lua` as well as `luac`.

### Integration tests

`integration/` runs the generated scripts on a real HappyView, at the release
in `integration/.env`, with the plugins in `integration/plugins.txt` (the list
infrastructure copies for `api.happyproto.at`):

```sh
docker compose -f integration/compose.yml up -d --wait
bun run gen && bun run test:integration
docker compose -f integration/compose.yml down -v
```

The stack has a PLC directory and a PDS holding four real accounts
(`happyproto`, `staff`, `customer`, `outsider`), fakes for the provisioner,
ClickHouse and Jetstream, and Caddy in front of the PDS: the accounts' DID
documents name the PDS as `https://pds.localhost`, and the registry's jobs
fetch from whatever PDS a DID document names, so HappyView trusts Caddy's CA
and reaches the PDS over TLS as it would a real one. `HAPPYPROTO_DID` is
`happyproto`'s DID, and setup bootstraps the admin and customers spaces by
calling `admin.createSpaces` as `happyproto` with `staff` in the staff list,
as production does. Tests sign HappyView sessions for those accounts
with the stack's known `SESSION_SECRET` (`integration/session.ts`), and every
successful reply is validated against its lexicon's output schema. CI runs it
on every pull request, and `deploy` waits for it.

Records reach the index through the fake Jetstream (`emitCommit`), and
HappyView refuses an event whose record does not hash to its CID, so
`integration/registry.test.ts` writes each record to the PDS and emits it with
the CID the PDS answered, or computes the CID itself (dag-cbor, sha2-256) for
an event the PDS never sees. HappyView refuses a procedure call with no
session before any script runs, and the accounts have no OAuth session with
their PDS, so the gateway procedures are exercised up to the point of writing
(their refusals and `validateOnly`); their writes are unit tested.

A script's path becomes its NSID — `lua/com/happyproto/getMe.lua` binds to
`com.happyproto.getMe` — and the **trigger type comes from the paired
lexicon's `defs.main.type`**, not from the script. A `query` lexicon yields
`xrpc.query`, a `procedure` yields `xrpc.procedure`, a `record` yields
`record.index`. A script with no matching lexicon has nothing to derive a
trigger from.

```
lexicons/com/happyproto/getMe.json   # id: com.happyproto.getMe, type: query
lua/com/happyproto/getMe.lua         # → xrpc.query:com.happyproto.getMe
```

## The plugin registry

HappyView plugins are published as [`software.release`](https://release.software)
records in the publisher's own repo, and `at.happyproto.registry.*` indexes
them, copies their bytes and serves them to HappyView and hpy.

### Records

| Collection | Key | What it is |
| --- | --- | --- |
| `software.release.project` | `<name>` | the project |
| `at.happyproto.registry.project` | `<name>` | the sidecar that makes the project a HappyView plugin: its plugin type, keywords, authors, security contacts, and a strongRef to its publication |
| `site.standard.publication` | `<name>` | display name, description, link and icon |
| `software.release.manifest` | TID | carries exactly one `at.happyproto.plugin.v1` artifact: the `.wasm` package and `manifest.json` as blobs, banner and screenshots, and the plugin's facts |
| `software.release.version` | `<name>.<version>` | pins a manifest by CID; may link a `site.standard.document` changelog |
| `software.release.channel` | `<name>.<channel>` | `latest`, `beta` or `alpha`, pinning a version by CID |
| `software.release.status` | TID | a lifecycle event about a version or the project |

Only a project with a valid sidecar is indexed: any other `software.release.*`
record is skipped. Manifests, versions and statuses are immutable, so a
rewrite keeps the first record, and a rewritten manifest or version marks the
version `suspect`. A record that names something not indexed yet is skipped
and not recovered: Jetstream delivers a repo's commits in order, and the
gateway writes every record after what it references. HappyView does not check
a record against its lexicon on the way in, so the index scripts hold every
limit the lexicons state.

A status's `status` is an ECMA-428 event type. Per subject, the last one not
withdrawn decides the state, and a project's state applies to each version
unless the version's own is worse:

| Last event | State | Installable |
| --- | --- | --- |
| none | `active` | yes |
| `endOfDevelopment`, `endOfSupport`, `supersededBy` | `deprecated` | yes |
| `endOfDistribution` | `unavailable` | no |
| `endOfLife` | `retired` | no |

`withdrawn` cancels the status its `withdraws` names, and `supersededBy` names
the version to use instead.

### Procedures

Each writes to the signed-in caller's repo, one record at a time in dependency
order, and checks its input with the same rules the indexer applies, so a
release the registry would skip is refused before it is written.

| Procedure | Writes |
| --- | --- |
| `putProject` | the publication, the sidecar pinning it, and the project; afterwards the publication and the sidecar (`swapCid` guards the sidecar) |
| `publishRelease` | the manifest, the changelog document, the version, and the channel `track` names. Called again after a failure part-way, it reuses what was written and finishes (`resumed`) |
| `promoteRelease` | a new version on an existing version's manifest, and optionally moves a channel to it |
| `putStatus` | a status about one of the caller's versions or their project |
| `retryVersion` | nothing: `HAPPYPROTO_DID` only, it queues the blob copy again; for a version deleted at its source the copy keeps any blob still fetchable but never makes it `available` |

`putProject` and `publishRelease` take `validateOnly`.

### Queries

`searchProjects`, `getProject`, `listVersions`, `getVersion`, `resolveChannel`
and `getArtifact`, all anonymous. A version is `pending` until its package and
manifest are copied and verified, then `available`; `deletedAtSource` once the
publisher deletes it or its manifest, though bytes already held stay served. `getArtifact` serves only bytes the registry
holds for an indexed version or a cached icon, by CID or by version and kind,
never a redirect to the publisher.

### Jobs and state

| Job | Does |
| --- | --- |
| `registry.copy-version` | fetches each blob of a version's artifact with `com.atproto.sync.getBlob` from the PDS the publisher's DID document names, and keeps it only if it hashes to the declared CID |
| `registry.fetch-publication` | caches the publication the sidecar pins, if its CID matches, and copies its icon |
| `registry.fetch-changelog` | caches a version's changelog document; `getVersion` refreshes it at most once an hour |

What the registry derives is written with `save_local` under `HAPPYPROTO_DID`
in collections that are deliberately not registered as lexicons, so nobody can
publish rows into them: `at.happyproto.registry.versionState` (`<did>:<name>:<version>`:
availability, `suspect`, the held blobs), `at.happyproto.registry.projectState`
(`<did>:<name>`: the cached publication, and marks for a deleted sidecar, a
rewritten or deleted manifest, or a deleted channel, which stops resolving
until it is written again) and `at.happyproto.registry.changelogCache`
(`<did>:<name>:<version>`).

### Vendored lexicons

`vendor/lexicons/` holds the upstream `software.release.*` lexicons, copied
verbatim. They are deployed so HappyView subscribes to and indexes those
collections, and never published: HappyProto does not own that authority.
The `site.standard.*` lexicons are not deployed at all, since nothing indexes
them and the record library skips validation for a collection with no
lexicon.

## Deployment

Push to `main` deploys. Pull requests lint and then dry-run, so a review shows
what a merge would actually replace rather than only that the files parse.

Four things must be configured on the repo:

| Kind | Name | Value |
| --- | --- | --- |
| Variable | `HAPPYVIEW_URL` | `https://api.happyproto.at` |
| Secret | `HAPPYVIEW_API_KEY` | an `hv_` admin API key from the instance |
| Secret | `LEXICON_APP_PASSWORD` | an app password for `@happyproto.at` |
| Secret | `HAPPYVIEW_DEV_LEXICON_APP_PASSWORD` | an app password for `@happyview.dev` |

After a deploy, the lexicons are published as `com.atproto.lexicon.schema`
records in `@happyproto.at`'s repo, with
[`happyproto/actions/lexicon-publish`](https://github.com/happyproto/actions#lexicon-publish).
A PDS that resolves lexicons on demand finds them through DNS, so each NSID
authority needs a TXT record naming that account:

| Name | Value |
| --- | --- |
| `_lexicon.actor.happyproto.at` | `did=did:plc:mo7vq4jbioxwafy5zkcc3eux` |
| `_lexicon.admin.happyproto.at` | `did=did:plc:mo7vq4jbioxwafy5zkcc3eux` |
| `_lexicon.fleet.happyproto.at` | `did=did:plc:mo7vq4jbioxwafy5zkcc3eux` |
| `_lexicon.plugin.happyproto.at` | `did=did:plc:mo7vq4jbioxwafy5zkcc3eux` |
| `_lexicon.registry.happyproto.at` | `did=did:plc:mo7vq4jbioxwafy5zkcc3eux` |
| `_lexicon.server.happyproto.at` | `did=did:plc:mo7vq4jbioxwafy5zkcc3eux` |

A new authority (`at.happyproto.<new>.*`) needs its own record: the publish
step fails until it exists, naming the record to add, and so does the pull
request's dry run.

### Other accounts

Some lexicons belong to an authority HappyProto doesn't own, so they're
published to that authority's account instead. Each one has a directory under
`accounts/`, an entry in `scripts/publishing.ts`, and a matching entry in the
Deploy workflow's `publish-lexicons` matrix and in the pull request plan:

| Directory | NSIDs | Account | Secret |
| --- | --- | --- | --- |
| `lexicons/` | `at.happyproto.*` | `@happyproto.at` | `LEXICON_APP_PASSWORD` |
| `accounts/happyview.dev/` | `dev.happyview.*` | `@happyview.dev` (`did:plc:qneu5uamqs6cug7sjobbaexm`) | `HAPPYVIEW_DEV_LEXICON_APP_PASSWORD` |

These directories aren't uploaded to HappyView; they're only published. The
tests keep every NSID in its own account's directory and the workflow in step
with the table. If anything slips past, lexicon-publish refuses any directory
whose `_lexicon` DNS names a different account. Permission sets are also
checked against the [permission spec](https://atproto.com/specs/permission#permission-sets)
before they're published, because a PDS silently ignores a permission it
can't read.

To add an account, create an app password on it and save it as a repo secret.
Then add the account to `scripts/publishing.ts`, to the workflow matrix and to
the plan, and add its `_lexicon` TXT records.

`prune` is deliberately **off**. With it on, deleting a file here deletes the
live lexicon or script — and for a record-type lexicon that also orphans
indexed data. Deletions should be deliberate and by hand until there is a
reason to automate them.

## Writing a query script

Scripts run in a sandboxed Lua VM with an instruction limit, under the
HappyView v3 script contract. `handle(input, ctx)` is called per request and
its return value is serialised as the JSON response. `input` is the query
parameters (or a procedure's body); `ctx` carries **`ctx.caller_did`** — the
authenticated user, and therefore the hook for every authorization decision —
and `ctx.env`, the script variables. Read both only inside functions: the file
body runs once at load, before there is any caller.

Libraries come from `require`: `internal.json` and `internal.logging` are
built in, and `happyview.http`, `happyview.spaces`, `happyview.xrpc` and
`happyview.jobs` are library plugins the instance must have installed.

ClickHouse is reached over `happyview.http`, not `happyview.db`: `db` reads
HappyView's records, not arbitrary SQL. Credentials belong in encrypted
**script variables** (`ctx.env`), never inline.

Two rules that matter more than they look:

1. **Parameterise every query.** Build SQL by interpolating `params` and you
   have written an injection. ClickHouse's HTTP interface takes `param_<name>`
   arguments with `{name:Type}` placeholders — use them.
2. **Enforce the cohort minimum.** Fleet benchmarks compare paying customers
   to each other. The collector refuses to publish a benchmark below a cohort
   of 10 and withholds the metric instead; a query endpoint must not become
   the way around that by letting a caller narrow a filter until the cohort is
   one other customer.

## Script variables

Secrets and configuration the scripts read from `ctx.env`. Set them on
the instance with the admin API — they are encrypted at rest using
`TOKEN_ENCRYPTION_KEY`, so that key must be configured before any of this
works.

| Key | Value |
| --- | --- |
| `HAPPYPROTO_DID` | HappyProto's own account DID: the authority of both spaces. Never the instance's service DID (see below) |
| `HAPPYPROTO_CLICKHOUSE_URL` | `http://clickhouse:8123` |
| `HAPPYPROTO_CLICKHOUSE_USER` | `readonly` |
| `HAPPYPROTO_CLICKHOUSE_PASSWORD` | from the infrastructure vault (`vault_clickhouse_readonly_password`) |
| `HAPPYPROTO_CLICKHOUSE_DB` | `happyproto_telemetry` |
| `PROVISIONER_URL` | the provisioner's base URL |
| `PROVISIONER_TOKEN` | the provisioner's bearer token |

ClickHouse is reached over the shared Docker network by container name, which
is why the URL is `http://clickhouse:8123` and not a public address —
ClickHouse never leaves loopback. The `readonly` user holds `SELECT` only on
the telemetry database, verified by the infrastructure repo's `happyview`
tag: it asserts both that the credential works *and* that a `CREATE TABLE`
through it is refused.

Credentials travel to ClickHouse as `x-clickhouse-*` headers rather than in
the URL, so they stay out of any proxy or access log that records query
strings.

```bash
curl -sX POST https://api.happyproto.at/admin/script-variables \
  -H "Authorization: Bearer $HV_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "key": "HAPPYPROTO_DID",
    "value": "did:plc:4jrld6fwpnwqehtce56qshzv"
  }'
```

Both spaces are fixed, and derived from it:

| Space | Uri | Members may |
| --- | --- | --- |
| admin | `at://<HAPPYPROTO_DID>/space/at.happyproto.admin/main` | use the dashboard (staff) |
| customers | `at://<HAPPYPROTO_DID>/space/at.happyproto.customers/main` | manage instances |

The DID lives here rather than in the dashboard's bundle on purpose. The gate
is "is the caller a member of *this* space", and the authority DID is the part
that makes it mean anything — matching on the space *type* would admit
everyone, because any user can create a space of any type and is auto-added to
their own as a write member. Keeping it server-side means a browser cannot be
pointed at a different space, and the rule cannot be edited by anyone holding
the bundle.

`HAPPYPROTO_DID` must be HappyProto's own **account**, and must never be the
instance's own service DID. On an instance that publishes a service identity,
HappyView anchors every new space under that DID, whoever creates it. With
`HAPPYPROTO_DID` set to it, any signed-in user could create
`at.happyproto.admin/main` before HappyProto does, become its creator, and so
pass the staff gate.

Scripts fail closed when it is absent, empty or not a DID: no authority means
nobody is a member of anything. A missing `PROVISIONER_URL` or
`PROVISIONER_TOKEN` answers `Upstream` rather than raising.

### Bootstrapping the spaces

Signed in as `HAPPYPROTO_DID`, call `at.happyproto.admin.createSpaces`, with
the staff to add if there are any:

```json
{ "staff": ["did:plc:..."] }
```

It creates whichever of the two spaces is missing, member-only to read and to
write, and adds each staff DID to the admin space with write access, skipping
anyone already a member. It is idempotent: run it again and it creates
nothing and adds no one. It answers each space's uri and whether this call
created it, and the staff it added. Any caller other than `HAPPYPROTO_DID`
is `Forbidden`.

HappyView anchors a new space on the instance's own DID when the instance
publishes a service identity, and on the creator's DID only when it does not.
On an instance that publishes one, the space would not be at the uri the gates
derive, so `createSpaces` removes it again and answers `Upstream` saying so.

`admin.addCustomer` and `admin.removeCustomer` change the customers space's
members as the calling staff member, and HappyView allows that only to the
space's creator or a HappyView super user. A staff member who is neither gets
`Forbidden`. The admin endpoints that read the provisioner also need the
caller's DID in the provisioner's `STAFF_DIDS`; without it they get the
provisioner's `Forbidden`.
