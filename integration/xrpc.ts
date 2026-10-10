/**
 * XRPC calls as a stack account, checked against this repo's lexicons.
 *
 * Every successful reply is validated against its lexicon's output schema
 * with @atproto/lexicon, so a script that renames, drops or mistypes a field
 * fails here even if the test only looks at one value. Every error reply
 * must name a code the lexicon declares.
 */
import { Lexicons } from "@atproto/lexicon";
import { expect } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { sessionCookie } from "./session";
import { HAPPYVIEW_URL, stack, type AccountName } from "./setup";

async function loadLexicons(dir = "lexicons"): Promise<any[]> {
  const out: any[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await loadLexicons(full)));
    else if (entry.name.endsWith(".json")) out.push(JSON.parse(await readFile(full, "utf8")));
  }
  return out;
}

const docs = await loadLexicons();
export const lexicons = new Lexicons(docs);

export type Reply = { status: number; body: any; text: string };

type CallOptions = {
  params?: Record<string, string | number | boolean | undefined>;
  input?: unknown;
};

/** The raw reply to `nsid` as `who`, or anonymously when `who` is null. */
export async function call(
  nsid: string,
  who: AccountName | null,
  { params, input }: CallOptions = {},
): Promise<Reply> {
  const { accounts, client } = await stack();
  const type = lexicons.getDefOrThrow(`lex:${nsid}#main`).type;

  const url = new URL(`/xrpc/${nsid}`, HAPPYVIEW_URL);
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  const headers: Record<string, string> = {
    "x-client-key": client.key,
    "x-client-secret": client.secret,
  };
  if (who) headers.cookie = sessionCookie(accounts[who].did);
  if (input !== undefined) headers["content-type"] = "application/json";

  const res = await fetch(url, {
    method: type === "procedure" ? "POST" : "GET",
    headers,
    body: input === undefined ? undefined : JSON.stringify(input),
  });
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body, text };
}

/** The lexicon's declared error names for `nsid`. */
export function declaredErrors(nsid: string): string[] {
  const main = lexicons.getDefOrThrow(`lex:${nsid}#main`) as { errors?: { name: string }[] };
  return (main.errors ?? []).map((e) => e.name);
}

/**
 * The output of a successful call, after asserting it is not an error and
 * that it validates against the lexicon's output schema.
 */
export async function ok(
  nsid: string,
  who: AccountName | null,
  options?: CallOptions,
): Promise<any> {
  const reply = await call(nsid, who, options);
  if (reply.status !== 200 || (reply.body && typeof reply.body === "object" && "error" in reply.body)) {
    throw new Error(`${nsid} as ${who ?? "anonymous"} failed: ${reply.status} ${reply.text}`);
  }
  // Throws with the offending path, e.g. `Output/signals/0 must have the property "label"`.
  lexicons.assertValidXrpcOutput(nsid, reply.body);
  return reply.body;
}

/**
 * The reply to a call expected to fail with `code`, after asserting it came
 * back as HTTP 400 `{error, message}`, and that the lexicon declares `code`.
 */
export async function fails(
  nsid: string,
  who: AccountName | null,
  code: string,
  options?: CallOptions,
): Promise<Reply> {
  const reply = await call(nsid, who, options);
  expect(declaredErrors(nsid)).toContain(code);
  // HTTP 400, as `com.atproto.sync.getBlob` answers a missing blob. An atproto
  // client decides whether a call failed from the status before it reads the
  // body, so a declared error at 200 is taken for a successful response and
  // then fails validation against the output schema.
  expect({ status: reply.status, error: reply.body?.error }).toEqual({ status: 400, error: code });
  expect(typeof reply.body?.message).toBe("string");
  return reply;
}
