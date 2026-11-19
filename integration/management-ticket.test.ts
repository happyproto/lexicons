/**
 * getManagementTicket against a real HappyView and its Lua interpreter: the
 * customer gate, the input checks, and the call the script makes to
 * `ctx.caller_assertion`.
 *
 * The stack signs callers in with a session cookie, and HappyView makes a
 * caller assertion only for a caller who signed in with DPoP: a run without
 * a DPoP session is refused before HappyView looks at its assertion settings.
 * So every call here stops at the assertion, and no ticket is issued. What it
 * proves is the pairing of this release with this interpreter: the deployed
 * script reaches `ctx.caller_assertion`, gets HappyView's refusal back with
 * its code, and turns that into the error the dashboard expects. Which
 * refusal it was is read from the script's own warning in the event log. The
 * ticket itself is covered where a DPoP session can be made: HappyView's
 * management_ticket_e2e and the provisioner's tests.
 */
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import pg from "pg";
import { DB_URL } from "./session";
import { setVariable, stack, type Stack } from "./setup";
import { fails } from "./xrpc";

const METHOD = "at.happyproto.server.getManagementTicket";
const INSTANCE = "f0000000-0000-4000-8000-000000000001";
const input = { instance: INSTANCE, keyProof: "a.key.proof" };

let s: Stack;
beforeAll(async () => {
  s = await stack();
});

async function query<T>(sql: string, params: unknown[]): Promise<T[]> {
  const client = new pg.Client(DB_URL);
  await client.connect();
  try {
    return (await client.query(sql, params)).rows as T[];
  } finally {
    await client.end();
  }
}

// HappyView writes created_at as RFC 3339 text in one format, so the event
// log's own newest stamp marks "before this call" without trusting this
// process's clock against the stack's.
const SCRIPT_WARNINGS = `FROM happyview_event_logs
  WHERE event_type = 'script.log' AND actor_did = $1 AND subject = $2
    AND detail::jsonb->>'message' = 'no caller assertion'`;

async function mark(did: string): Promise<string> {
  const rows = await query<{ at: string | null }>(`SELECT max(created_at) AS at ${SCRIPT_WARNINGS}`, [
    did,
    `xrpc.procedure:${METHOD}`,
  ]);
  return rows[0]?.at ?? "";
}

/** The fields of the first "no caller assertion" warning `did`'s calls logged after `since`. */
async function assertionRefusal(did: string, since: string): Promise<{ reason?: string; code?: string } | undefined> {
  const rows = await query<{ fields: { reason?: string; code?: string } }>(
    `SELECT detail::jsonb->'fields' AS fields ${SCRIPT_WARNINGS} AND created_at > $3 ORDER BY created_at LIMIT 1`,
    [did, `xrpc.procedure:${METHOD}`, since],
  );
  return rows[0]?.fields;
}

describe("getManagementTicket", () => {
  afterEach(async () => {
    await setVariable(s.apiKey, "PROVISIONER_AUDIENCE", s.variables.PROVISIONER_AUDIENCE);
  });

  test("is for customers only", async () => {
    await fails(METHOD, "outsider", "Forbidden", { input });
  });

  test("needs an instance UUID and a key proof", async () => {
    await fails(METHOD, "customer", "InvalidRequest", { input: { ...input, instance: "not-a-uuid" } });
    await fails(METHOD, "customer", "InvalidRequest", { input: { instance: INSTANCE } });
    await fails(METHOD, "customer", "InvalidRequest", { input: { ...input, keyProof: "" } });
  });

  test("asks HappyView for a caller assertion, which a sign-in without DPoP doesn't get", async () => {
    const since = await mark(s.accounts.customer.did);
    const reply = await fails(METHOD, "customer", "Unavailable", { input });
    expect(reply.body.message).toBe("Sign in again to manage this instance.");
    // HappyView's own refusal, with its code: the script called the real
    // ctx.caller_assertion rather than finding it missing, which would be
    // Upstream instead.
    expect(await assertionRefusal(s.accounts.customer.did, since)).toEqual({
      reason: "a caller assertion needs a caller who authenticated with DPoP",
      code: "NO_SESSION",
    });
  });

  test("with no audience set, the script says tickets aren't configured", async () => {
    await setVariable(s.apiKey, "PROVISIONER_AUDIENCE", "");
    const reply = await fails(METHOD, "customer", "Upstream", { input });
    expect(reply.body.message).toBe("Management tickets are not configured.");
  });
});
