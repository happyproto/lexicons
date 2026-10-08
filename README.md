# HappyProto lexicons

The `com.happyproto.*` lexicons and the Lua scripts that back them, deployed
to HappyProto's HappyView instance at **https://api.happyproto.at**.

This is how the dashboard gets data. HappyView is the authenticated API in
front of ClickHouse: a lexicon defines an XRPC method, and a Lua script
answers it — querying ClickHouse over the container network, with the caller's
DID in scope for authorization.

## Layout

Everything is discovered by directory layout. There is no manifest.

| Directory   | Pattern              | Becomes                                          |
| ----------- | -------------------- | ------------------------------------------------ |
| `lexicons/` | `**/*.json`          | uploaded lexicons (NSID from the `id` field)     |
| `lua/`      | `**/*.lua`           | `xrpc.query` / `xrpc.procedure` / `record.index` |
| `jobs/`     | `**/*.lua`           | `job.run:<type>`                                 |
| `labelers/` | `**/*.lua`           | `labeler.apply:<nsid>`                           |

### `lua/` is generated

Scripts are **authored in `src/`** and generated into `lua/` by `bun run gen`.
`lua/` is build output and is not in version control.

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
| `gate` | `gate_admin(ctx)`, `gate_customer(ctx)` | `failure` |
| `clickhouse` | `query(ctx, sql, params)` | `json`, `failure` |
| `provisioner` | `provisioner(ctx, method, path, body?, key?)`, `provisioner_failure(status, body)` | `json`, `failure` |
| `instance` | `public_instance(t, op)`, `admin_instance(t, op, host_name)`, `instance_state(t, op)`, `public_operation(op)` | `json` |

Blocks are emitted in **prelude file order**, never directive order, because a
Lua local must be declared before any function closing over it.

Each gate returns nil when the caller may proceed and a failure table
otherwise, and fails closed: no caller, an unset space variable, or a space
that cannot be read all refuse. A gated handler opens with it:

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

`bun test` checks that every script has a paired lexicon and defines
`handle(input, ctx)`; that nothing reads `ctx` or `env` at file scope; that
every `fleet.*` and `admin.*` handler opens with `gate_admin(ctx)` and every
`server.*` handler with `gate_customer(ctx)`; that every procedure writing
through the provisioner forwards `input.idempotencyKey`; that every lexicon
declares each error its script can return; that no source re-declares a
prelude helper or interpolates a caller value into SQL; and that all generated
output parses under `luac -p`. `scripts/prelude.test.ts` runs the prelude
itself under Lua 5.4 against stub modules, so it needs `lua` as well as `luac`.

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

## Deployment

Push to `main` deploys. Pull requests lint and then dry-run, so a review shows
what a merge would actually replace rather than only that the files parse.

Two things must be configured on the repo:

| Kind | Name | Value |
| --- | --- | --- |
| Variable | `HAPPYVIEW_URL` | `https://api.happyproto.at` |
| Secret | `HAPPYVIEW_API_KEY` | an `hv_` admin API key from the instance |

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
| `HAPPYPROTO_ADMIN_SPACE` | `at://did:plc:4jrld6fwpnwqehtce56qshzv/space/at.happyproto.admin/main` |
| `HAPPYPROTO_CLICKHOUSE_URL` | `http://clickhouse:8123` |
| `HAPPYPROTO_CLICKHOUSE_USER` | `readonly` |
| `HAPPYPROTO_CLICKHOUSE_PASSWORD` | from the infrastructure vault (`vault_clickhouse_readonly_password`) |
| `HAPPYPROTO_CLICKHOUSE_DB` | `happyproto_telemetry` |
| `HAPPYPROTO_CUSTOMERS_SPACE` | the customers space uri; its members may manage instances |
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
    "key": "HAPPYPROTO_ADMIN_SPACE",
    "value": "at://did:plc:4jrld6fwpnwqehtce56qshzv/space/at.happyproto.admin/main"
  }'
```

The space uri lives here rather than in the dashboard's bundle on purpose. The
gate is "is the caller a member of *this* space", and the authority DID is the
part that makes it mean anything — matching on the space *type* would admit
everyone, because any user can create a space of any type and is auto-added to
their own as a write member. Keeping the uri server-side means a browser
cannot be pointed at a different space, and the rule cannot be edited by
anyone holding the bundle.

Scripts fail closed when it is absent: no space configured means nobody is a
member. The same holds for `HAPPYPROTO_CUSTOMERS_SPACE`, and a missing
`PROVISIONER_URL` or `PROVISIONER_TOKEN` answers `Upstream` rather than
raising.
