/**
 * Brings the running stack (compose.yml) to the state every integration test
 * assumes: real accounts, the two spaces with their members, the script
 * variables, and this repo's lexicons and scripts deployed.
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

/** What the fakes expect, and what the scripts are configured to send. */
export const PROVISIONER_TOKEN = "integration-provisioner-token";
const CLICKHOUSE_USER = "integration";
const CLICKHOUSE_PASSWORD = "integration-clickhouse-password";

const HANDLE_DOMAIN = "integration.happyproto.at";
const PASSWORD = "Integration-password-123";

export type AccountName = "happyproto" | "staff" | "customer" | "outsider";
const ACCOUNTS: AccountName[] = ["happyproto", "staff", "customer", "outsider"];

export type Account = { did: string; handle: string };

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
    const body = (await created.json()) as { did: string };
    return { did: body.did, handle };
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
  const body = (await session.json()) as { did: string };
  return { did: body.did, handle };
}

/** Fails unless the DID resolves through the stack's PLC directory. */
async function assertInPlc(account: Account): Promise<void> {
  const res = await fetch(`${PLC_URL}/${account.did}`);
  if (!res.ok) throw new Error(`${account.handle} (${account.did}) is not in PLC: ${res.status}`);
}

/**
 * The space, as `authority`, the way the admin app's createAdminSpace makes
 * the admin space: listSpaces to adopt an existing one, else createSpace.
 */
async function space(
  authority: Account,
  clientKey: string,
  type: string,
  displayName: string,
): Promise<string> {
  const headers = {
    cookie: sessionCookie(authority.did),
    "x-client-key": clientKey,
    "content-type": "application/json",
  };
  const expected = `at://${authority.did}/space/${type}/main`;
  const listed = await expectOk(
    await fetch(`${HAPPYVIEW_URL}/xrpc/com.atproto.space.listSpaces?limit=100`, { headers }),
    "listSpaces",
  );
  if ((listed.spaces ?? []).some((s: { uri: string }) => s.uri === expected)) return expected;

  const created = await expectOk(
    await fetch(`${HAPPYVIEW_URL}/xrpc/com.atproto.simplespace.createSpace`, {
      method: "POST",
      headers,
      body: JSON.stringify({ type, skey: "main", displayName, mintPolicy: "member-list" }),
    }),
    `createSpace ${type}`,
  );
  return created.uri;
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
 * Deploy lexicons/**, lua/** and jobs/** through the admin API, with the
 * calls happyview-actions/deploy makes: POST /admin/lexicons, then POST
 * /admin/scripts with the trigger it derives from the paired lexicon's type.
 */
async function deploy(apiKey: string): Promise<void> {
  const headers = { authorization: `Bearer ${apiKey}`, "content-type": "application/json" };
  const scripts = await walk("lua", ".lua");
  if (scripts.length === 0) {
    throw new Error("lua/ is empty or missing. Run `bun run gen` before the integration tests.");
  }

  const types = new Map<string, string>();
  for (const file of await walk("lexicons", ".json")) {
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
    if (type !== "query" && type !== "procedure") {
      throw new Error(`${file}: no query or procedure lexicon ${nsid} to pair it with`);
    }
    triggers.push([`xrpc.${type}:${nsid}`, file]);
  }
  for (const file of await walk("jobs", ".lua")) {
    const type = relative("jobs", file).replace(/\.lua$/, "").split("/").join(".");
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

  const admin = await space(accounts.happyproto, client.key, "at.happyproto.admin", "HappyProto admins");
  const customers = await space(
    accounts.happyproto,
    client.key,
    "at.happyproto.customers",
    "HappyProto customers",
  );
  await putMember(accounts.happyproto, client.key, admin, accounts.staff.did);
  await putMember(accounts.happyproto, client.key, customers, accounts.customer.did);

  const variables: Record<string, string> = {
    HAPPYPROTO_ADMIN_SPACE: admin,
    HAPPYPROTO_CUSTOMERS_SPACE: customers,
    HAPPYPROTO_CLICKHOUSE_URL: "http://fake-clickhouse:8123",
    HAPPYPROTO_CLICKHOUSE_USER: CLICKHOUSE_USER,
    HAPPYPROTO_CLICKHOUSE_PASSWORD: CLICKHOUSE_PASSWORD,
    HAPPYPROTO_CLICKHOUSE_DB: "happyproto",
    PROVISIONER_URL: "http://fake-provisioner:8080",
    PROVISIONER_TOKEN,
  };
  for (const [key, value] of Object.entries(variables)) await setVariable(apiKey, key, value);

  await deploy(apiKey);

  return { accounts, spaces: { admin, customers }, apiKey, client, variables };
}

let pending: Promise<Stack> | undefined;

/** The set-up stack. Set up once per test process, however many files ask. */
export function stack(): Promise<Stack> {
  pending ??= setup();
  return pending;
}
