/**
 * Brings the running stack (compose.yml) to the state every integration test
 * assumes: real accounts, the script variables, this repo's lexicons and
 * scripts deployed, and the two spaces with their members -- bootstrapped by
 * `happyproto` calling admin.createSpaces, as production's are.
 *
 * Every step is idempotent, so a rerun against a stack that is already set up
 * converges rather than failing, and any number of test files can await
 * `stack()`.
 *
 * Needs `bun run gen` first: it deploys lua/, the generated scripts, exactly
 * as CI does.
 */
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { ensureTestUser, sessionCookie } from "./session";

export const HAPPYVIEW_URL = process.env.INTEGRATION_HAPPYVIEW_URL ?? "http://127.0.0.1:55200";
export const PDS_URL = process.env.INTEGRATION_PDS_URL ?? "http://127.0.0.1:55100";
export const PLC_URL = process.env.INTEGRATION_PLC_URL ?? "http://127.0.0.1:55582";
export const PROVISIONER_URL =
  process.env.INTEGRATION_PROVISIONER_URL ?? "http://127.0.0.1:55300";
export const CLICKHOUSE_URL = process.env.INTEGRATION_CLICKHOUSE_URL ?? "http://127.0.0.1:55400";
export const JETSTREAM_URL = process.env.INTEGRATION_JETSTREAM_URL ?? "http://127.0.0.1:55600";

/** What the fakes expect, and what the scripts are configured to send. */
export const PROVISIONER_TOKEN = "integration-provisioner-token";
const CLICKHOUSE_USER = "integration";
const CLICKHOUSE_PASSWORD = "integration-clickhouse-password";

const HANDLE_DOMAIN = "integration.happyproto.at";
const PASSWORD = "Integration-password-123";

export type AccountName = "happyproto" | "staff" | "customer" | "outsider";
const ACCOUNTS: AccountName[] = ["happyproto", "staff", "customer", "outsider"];

/** `accessJwt` is kept so a test can write to the account's own repo. */
export type Account = { did: string; handle: string; accessJwt: string };

export type Stack = {
  accounts: Record<AccountName, Account>;
  spaces: { admin: string; customers: string };
  /** An admin API key, as `happyproto`, a super user. */
  apiKey: string;
  /** The registered API client every XRPC call identifies itself as. */
  client: { key: string; secret: string };
  /** The script variables as set, for a test that changes one to restore. */
  variables: Record<string, string>;
};

// ---------------------------------------------------------------------------

async function waitFor(url: string, name: string, timeoutMs = 120_000): Promise<void> {
  const start = Date.now();
  let last = "";
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
      last = `HTTP ${res.status}`;
    } catch (e) {
      last = (e as Error).message;
    }
    await Bun.sleep(1000);
  }
  throw new Error(
    `${name} is not answering at ${url} (${last}). Is the stack up?\n` +
      "  docker compose -f integration/compose.yml up -d --wait",
  );
}

async function expectOk(res: Response, what: string): Promise<any> {
  const text = await res.text();
  if (!res.ok) throw new Error(`${what} answered ${res.status}: ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : null;
}

/** A PDS account, created on the first run and signed into on later ones. */
async function account(name: AccountName): Promise<Account> {
  // Prefixed: the PDS reserves some bare words as handles, `staff` among them.
  const handle = `it-${name}.${HANDLE_DOMAIN}`;
  const created = await fetch(`${PDS_URL}/xrpc/com.atproto.server.createAccount`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ handle, email: `${name}@example.com`, password: PASSWORD }),
  });
  if (created.ok) {
    const body = (await created.json()) as { did: string; accessJwt: string };
    return { did: body.did, handle, accessJwt: body.accessJwt };
  }
  const session = await fetch(`${PDS_URL}/xrpc/com.atproto.server.createSession`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identifier: handle, password: PASSWORD }),
  });
  if (!session.ok) {
    throw new Error(
      `could neither create nor sign in as ${handle}: createAccount ${created.status} ` +
        `${await created.text()}; createSession ${session.status} ${await session.text()}`,
    );
  }
  const body = (await session.json()) as { did: string; accessJwt: string };
  return { did: body.did, handle, accessJwt: body.accessJwt };
}

/** Fails unless the DID resolves through the stack's PLC directory. */
async function assertInPlc(account: Account): Promise<void> {
  const res = await fetch(`${PLC_URL}/${account.did}`);
  if (!res.ok) throw new Error(`${account.handle} (${account.did}) is not in PLC: ${res.status}`);
}

/**
 * HappyProto's two spaces, created by `owner` calling admin.createSpaces with
 * `staff`, as production bootstraps them. Idempotent, so a rerun against a
 * stack already set up adopts the existing spaces. Called directly rather
 * than through xrpc.ts, which needs the stack this is building.
 */
async function createSpaces(
  owner: Account,
  client: { key: string; secret: string },
  staff: string[],
): Promise<{ admin: string; customers: string }> {
  const reply = await expectOk(
    await fetch(`${HAPPYVIEW_URL}/xrpc/at.happyproto.admin.createSpaces`, {
      method: "POST",
      headers: {
        cookie: sessionCookie(owner.did),
        "x-client-key": client.key,
        "x-client-secret": client.secret,
        "content-type": "application/json",
      },
      body: JSON.stringify({ staff }),
    }),
    "admin.createSpaces",
  );
  if (reply?.error) {
    throw new Error(`admin.createSpaces answered ${reply.error}: ${reply.message}`);
  }
  return { admin: reply.adminSpace.uri, customers: reply.customersSpace.uri };
}

/** Add `member` to the space with read access, as its authority. */
export async function putMember(
  authority: Account,
  clientKey: string,
  spaceUri: string,
  member: string,
): Promise<void> {
  await expectOk(
    await fetch(`${HAPPYVIEW_URL}/xrpc/com.atproto.simplespace.putMember`, {
      method: "POST",
      headers: {
        cookie: sessionCookie(authority.did),
        "x-client-key": clientKey,
        "content-type": "application/json",
      },
      body: JSON.stringify({ space: spaceUri, did: member, read: true, write: false }),
    }),
    `putMember ${member}`,
  );
}

/** Remove `member` from the space, as its authority. */
export async function removeMember(
  authority: Account,
  clientKey: string,
  spaceUri: string,
  member: string,
): Promise<void> {
  await expectOk(
    await fetch(`${HAPPYVIEW_URL}/xrpc/com.atproto.simplespace.removeMember`, {
      method: "POST",
      headers: {
        cookie: sessionCookie(authority.did),
        "x-client-key": clientKey,
        "content-type": "application/json",
      },
      body: JSON.stringify({ space: spaceUri, did: member }),
    }),
    `removeMember ${member}`,
  );
}

/**
 * Every plugin in plugins.txt is installed and enabled, with the digest the
 * file pins. HappyView logs a plugin that fails to load and boots anyway, so
 * without this a bad entry surfaces as unrelated-looking script failures.
 */
async function assertPlugins(apiKey: string): Promise<void> {
  const wanted = (await readFile("integration/plugins.txt", "utf8"))
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const [id, , digest] = line.split("|");
      return { id, sha256: digest?.replace(/^sha256:/, "") };
    });
  const { plugins } = await expectOk(
    await fetch(`${HAPPYVIEW_URL}/admin/plugins`, {
      headers: { authorization: `Bearer ${apiKey}` },
    }),
    "list plugins",
  );
  const problems: string[] = [];
  for (const { id, sha256 } of wanted) {
    const found = (plugins as { id: string; enabled: boolean; sha256?: string }[]).find(
      (p) => p.id === id,
    );
    if (!found) {
      problems.push(`${id} is not installed`);
    } else if (!found.enabled) {
      problems.push(`${id} is installed but disabled`);
    } else if (found.sha256 !== sha256) {
      problems.push(`${id} has digest ${found.sha256}, plugins.txt pins ${sha256}`);
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `plugins.txt and the running HappyView disagree:\n  ${problems.join("\n  ")}\n` +
        "See `docker compose -f integration/compose.yml logs happyview` for why a plugin failed to load.",
    );
  }
}

/** Set one script variable through the admin API. */
export async function setVariable(apiKey: string, key: string, value: string): Promise<void> {
  await expectOk(
    await fetch(`${HAPPYVIEW_URL}/admin/script-variables`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ key, value }),
    }),
    `set script variable ${key}`,
  );
}

async function walk(dir: string, ext: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  const out: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full, ext)));
    else if (entry.name.endsWith(ext)) out.push(full);
  }
  return out.sort();
}

/**
 * Deploy lexicons/**, vendor/lexicons/** and lua/** (scripts and, under
 * lua/jobs/, jobs) through the admin API, with the
 * calls happyview-actions/deploy makes: POST /admin/lexicons, then POST
 * /admin/scripts with the trigger it derives from the paired lexicon's type.
 */
async function deploy(apiKey: string): Promise<void> {
  const headers = { authorization: `Bearer ${apiKey}`, "content-type": "application/json" };
  const jobFiles = await walk("lua/jobs", ".lua");
  const scripts = (await walk("lua", ".lua")).filter((file) => !jobFiles.includes(file));
  if (scripts.length === 0) {
    throw new Error("lua/ is empty or missing. Run `bun run gen` before the integration tests.");
  }

  const types = new Map<string, string>();
  // The vendored lexicons are deployed so the registry can index them; only
  // the workflow's lexicon-publish step ever decides what gets published.
  const lexiconFiles = [
    ...(await walk("lexicons", ".json")),
    ...(await walk("vendor/lexicons", ".json")),
  ];
  for (const file of lexiconFiles) {
    const lexicon = JSON.parse(await readFile(file, "utf8"));
    types.set(lexicon.id, lexicon.defs?.main?.type);
    await expectOk(
      await fetch(`${HAPPYVIEW_URL}/admin/lexicons`, {
        method: "POST",
        headers,
        body: JSON.stringify({ lexicon_json: lexicon, backfill: false }),
      }),
      `deploy lexicon ${lexicon.id}`,
    );
  }

  const triggers: [string, string][] = [];
  for (const file of scripts) {
    const nsid = relative("lua", file).replace(/\.lua$/, "").split("/").join(".");
    const type = types.get(nsid);
    // The trigger comes from the paired lexicon's type, exactly as the deploy
    // action derives it: a query or procedure is an XRPC handler, a record is
    // an indexer that fires on any event in its collection.
    if (type === "query" || type === "procedure") {
      triggers.push([`xrpc.${type}:${nsid}`, file]);
    } else if (type === "record") {
      triggers.push([`record.index:${nsid}`, file]);
    } else {
      throw new Error(
        `${file}: no query, procedure or record lexicon ${nsid} to pair it with`,
      );
    }
  }
  for (const file of jobFiles) {
    const type = relative("lua/jobs", file).replace(/\.lua$/, "").split("/").join(".");
    triggers.push([`job.run:${type}`, file]);
  }

  for (const [id, file] of triggers) {
    await expectOk(
      await fetch(`${HAPPYVIEW_URL}/admin/scripts`, {
        method: "POST",
        headers,
        body: JSON.stringify({ id, script_type: "lua", body: await readFile(file, "utf8") }),
      }),
      `deploy script ${id}`,
    );
  }
}

async function setup(): Promise<Stack> {
  await Promise.all([
    waitFor(`${HAPPYVIEW_URL}/health`, "HappyView"),
    waitFor(`${PDS_URL}/xrpc/_health`, "the PDS"),
    waitFor(`${PLC_URL}/_health`, "the PLC directory"),
    waitFor(`${PROVISIONER_URL}/__health`, "the fake provisioner"),
    waitFor(`${CLICKHOUSE_URL}/__health`, "the fake ClickHouse"),
  ]);

  const accounts = {} as Record<AccountName, Account>;
  for (const name of ACCOUNTS) {
    accounts[name] = await account(name);
    await assertInPlc(accounts[name]);
  }

  // The operator. A super user, so its session can mint the admin API key
  // and register the API client, as a fresh instance's first sign-in would.
  await ensureTestUser(accounts.happyproto.did, true);
  const operator = {
    cookie: sessionCookie(accounts.happyproto.did),
    "content-type": "application/json",
  };

  const { key: apiKey } = await expectOk(
    await fetch(`${HAPPYVIEW_URL}/admin/api-keys`, {
      method: "POST",
      headers: operator,
      // What a deploy needs, plus setting script variables.
      body: JSON.stringify({
        name: `integration ${Date.now()}`,
        permissions: [
          "lexicons:create",
          "lexicons:read",
          "scripts:manage",
          "scripts:read",
          "script-variables:create",
          "script-variables:read",
          "plugins:read",
        ],
      }),
    }),
    "create admin API key",
  );

  await assertPlugins(apiKey);

  const registered = await expectOk(
    await fetch(`${HAPPYVIEW_URL}/admin/api-clients`, {
      method: "POST",
      headers: operator,
      body: JSON.stringify({
        name: "integration tests",
        client_id_url: `https://integration.happyproto.at/oauth/${crypto.randomUUID()}`,
        client_uri: "https://integration.happyproto.at",
        redirect_uris: [],
        client_type: "confidential",
        // Generous: the suite makes a few hundred calls in a burst.
        rate_limit_capacity: 100_000,
        rate_limit_refill_rate: 10_000,
      }),
    }),
    "register API client",
  );
  const client = { key: registered.client_key as string, secret: registered.client_secret as string };

  const variables: Record<string, string> = {
    HAPPYPROTO_DID: accounts.happyproto.did,
    HAPPYPROTO_CLICKHOUSE_URL: "http://fake-clickhouse:8123",
    HAPPYPROTO_CLICKHOUSE_USER: CLICKHOUSE_USER,
    HAPPYPROTO_CLICKHOUSE_PASSWORD: CLICKHOUSE_PASSWORD,
    HAPPYPROTO_CLICKHOUSE_DB: "happyproto",
    PROVISIONER_URL: "http://fake-provisioner:8080",
    PROVISIONER_TOKEN,
  };
  for (const [key, value] of Object.entries(variables)) await setVariable(apiKey, key, value);

  await deploy(apiKey);

  const { admin, customers } = await createSpaces(accounts.happyproto, client, [accounts.staff.did]);
  await putMember(accounts.happyproto, client.key, customers, accounts.customer.did);

  return { accounts, spaces: { admin, customers }, apiKey, client, variables };
}

let pending: Promise<Stack> | undefined;

/** The set-up stack. Set up once per test process, however many files ask. */

// ---------------------------------------------------------------------------
// The fake firehose
// ---------------------------------------------------------------------------

/**
 * Wait until HappyView's subscription has reached the fake. An event emitted
 * before it lands is delivered to nobody, and the test then fails wherever
 * the record was expected rather than here.
 */
export async function awaitFirehose(timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await fetch(`${JETSTREAM_URL}/__subscribers`).catch(() => null);
    if (response?.ok) {
      const { count } = (await response.json()) as { count: number };
      if (count > 0) return;
    }
    await Bun.sleep(250);
  }
  throw new Error(`no firehose subscriber after ${timeoutMs}ms`);
}

/**
 * Push a record through the firehose as a commit. Answers how many
 * subscribers it reached, and throws on none, because a silently dropped
 * event is the failure this harness exists to avoid.
 */
export async function emitCommit(event: {
  did: string;
  collection: string;
  rkey: string;
  record?: unknown;
  operation?: "create" | "update" | "delete";
  cid?: string;
}): Promise<void> {
  const { did, operation, ...commit } = event;
  const response = await fetch(`${JETSTREAM_URL}/__emit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ did, commit: { ...commit, operation: operation ?? "create" } }),
  });
  if (!response.ok) {
    throw new Error(`emitCommit: ${response.status} ${await response.text()}`);
  }
  const { delivered } = (await response.json()) as { delivered: number };
  if (delivered === 0) {
    throw new Error("emitCommit: nothing was subscribed; call awaitFirehose first");
  }
}

/**
 * Poll until `check` answers something truthy. Indexing is asynchronous --
 * the firehose hands the record off and the trigger runs on its own -- so a
 * read straight after an emit is a race.
 */
export async function eventually<T>(
  check: () => Promise<T | null | undefined | false>,
  { timeoutMs = 15_000, label = "condition" }: { timeoutMs?: number; label?: string } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
      last = value;
    } catch (error) {
      last = error;
    }
    await Bun.sleep(250);
  }
  throw new Error(`${label} did not hold within ${timeoutMs}ms (last: ${String(last)})`);
}

export function stack(): Promise<Stack> {
  pending ??= setup();
  return pending;
}
