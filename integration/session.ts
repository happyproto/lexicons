/**
 * HappyView sessions without a browser, ported from HappyView's
 * web/tests/e2e/auth-helper.ts (origin/alpha).
 *
 * HappyView's session is a `happyview_session` cookie signed by the `cookie`
 * crate's SignedCookieJar, with a key derived from SESSION_SECRET. The stack
 * runs with a known secret, so a test can sign the cookie for any DID itself
 * instead of driving a browser through PDS consent screens. The DIDs are
 * still real: each one is an account in the stack's PLC directory and PDS.
 */
import { createHmac } from "node:crypto";
import pg from "pg";

export const SESSION_SECRET = "e2e-test-secret-that-is-at-least-32-bytes";
export const COOKIE_NAME = "happyview_session";
export const DB_URL =
  process.env.INTEGRATION_DB_URL ?? "postgres://happyview:happyview@127.0.0.1:55432/happyview";

/**
 * HKDF-Expand (RFC 5869 section 2.3). The cookie crate's Key::derive_from
 * treats the master key as the PRK directly, so there is no extract step.
 */
function hkdfExpand(prk: Buffer, info: Buffer, length: number): Buffer {
  const hashLen = 32;
  const n = Math.ceil(length / hashLen);
  const output = Buffer.alloc(n * hashLen);
  let prev = Buffer.alloc(0);
  for (let i = 1; i <= n; i++) {
    const hmac = createHmac("sha256", prk);
    hmac.update(prev);
    hmac.update(info);
    hmac.update(Buffer.from([i]));
    prev = hmac.digest();
    prev.copy(output, (i - 1) * hashLen);
  }
  return output.subarray(0, length);
}

/** The first half of the derived key signs; the second half encrypts. */
function deriveSigningKey(secret: string): Buffer {
  const info = Buffer.from("COOKIE;SIGNED:HMAC-SHA256;PRIVATE:AEAD-AES-256-GCM");
  return hkdfExpand(Buffer.from(secret), info, 64).subarray(0, 32);
}

const SIGNING_KEY = deriveSigningKey(SESSION_SECRET);

/**
 * A `Cookie` header value for a session as `did`: the HMAC, base64, followed
 * by the value, exactly as the cookie crate's SignedCookieJar writes it.
 *
 * XRPC calls send the API client's key as an `x-client-key` header beside
 * this, as HappyView's own XRPC tests do, rather than packing it into the
 * cookie: that form separates the two with a newline, which a header cannot
 * carry.
 */
export function sessionCookie(did: string): string {
  const mac = createHmac("sha256", SIGNING_KEY).update(did).digest("base64");
  return `${COOKIE_NAME}=${mac}${did}`;
}

/**
 * Make `did` a HappyView user, as a super user when `superUser`. The admin
 * API answers only to users in this table; a first-run instance has none, so
 * the first one goes in through the database, as HappyView's e2e does.
 */
export async function ensureTestUser(did: string, superUser = false): Promise<void> {
  const client = new pg.Client(DB_URL);
  await client.connect();
  try {
    await client.query(
      `INSERT INTO happyview_users (id, did, is_super, created_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (did) DO UPDATE SET is_super = EXCLUDED.is_super`,
      [crypto.randomUUID(), did, superUser ? 1 : 0, new Date().toISOString()],
    );
  } finally {
    await client.end();
  }
}
