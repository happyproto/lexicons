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

Scripts run in a sandboxed Lua VM with an instruction limit. `handle()` is
called per request and its return value is serialised as the JSON response.

Available: `db` (HappyView's own record store), `http` (an HTTP client),
`json`, `xrpc`, and context globals including **`caller_did`** — the
authenticated user, and therefore the hook for every authorization decision.

ClickHouse is reached over `http`, not `db`: `db` reads HappyView's records,
not arbitrary SQL. Credentials belong in encrypted **script variables**
(`env`), never inline.

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

Secrets and configuration the scripts read from the `env` global. Set them on
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
member.
