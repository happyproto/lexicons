/**
 * at.happyproto.internal.* (HAP-463 phase 2) on a real HappyView v3: with
 * PROVISIONER_DID set, every signed-in account is refused, HappyProto's own
 * included. Only a service-auth token signed as PROVISIONER_DID gets in, and
 * nothing in this stack can sign one; what the script answers that caller is
 * proven in scripts/getOwnerContacts.test.ts.
 */
import { beforeAll, describe, test } from "bun:test";
import { stack } from "./setup";
import { fails } from "./xrpc";

const SPACE = "at://did:plc:nobody/space/at.happyproto.preferences/self";

beforeAll(async () => {
  await stack();
});

describe("internal.getOwnerContacts", () => {
  test("refuses every signed-in account as Forbidden", async () => {
    for (const who of ["happyproto", "staff", "customer", "outsider"] as const) {
      await fails("at.happyproto.internal.getOwnerContacts", who, "Forbidden", { params: { spaces: SPACE } });
    }
  });
});
