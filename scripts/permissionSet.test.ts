import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { permissionSetProblems } from "./permissionSet";
import { DESTINATIONS, lexiconFiles } from "./publishing";

const RPC = {
  type: "permission",
  resource: "rpc",
  lxm: ["com.example.admin.manage"],
  aud: "*",
};

function set(...permissions: unknown[]) {
  return {
    lexicon: 1,
    id: "com.example.fullAccess",
    defs: { main: { type: "permission-set", title: "Full access", permissions } },
  };
}

describe("permissionSetProblems", () => {
  test("accepts an rpc permission in the set's own namespace", () => {
    expect(permissionSetProblems(set(RPC))).toEqual([]);
  });

  test("accepts repo collections in a child group", () => {
    const repo = {
      type: "permission",
      resource: "repo",
      collection: ["com.example.feed.post"],
      action: ["create", "delete"],
    };
    expect(permissionSetProblems(set(repo))).toEqual([]);
  });

  test("accepts inheritAud in place of aud", () => {
    const { aud: _, ...rest } = RPC;
    expect(permissionSetProblems(set({ ...rest, inheritAud: true }))).toEqual([]);
  });

  test("ignores a document with no permission set", () => {
    const record = { lexicon: 1, id: "com.example.post", defs: { main: { type: "record" } } };
    expect(permissionSetProblems(record)).toEqual([]);
  });

  // A PDS drops a permission it can't read rather than refusing the set, so
  // each of these would publish cleanly and then quietly grant nothing.
  test.each([
    ["an empty permission list", set(), /no permissions/],
    ["a scalar lxm", set({ ...RPC, lxm: "com.example.admin.manage" }), /lxm must be a non-empty list/],
    ["a wildcard lxm", set({ ...RPC, lxm: ["com.example.*"] }), /wildcard/],
    ["a sibling namespace", set({ ...RPC, lxm: ["org.other.admin.manage"] }), /outside com\.example/],
    ["a parent namespace", set({ ...RPC, lxm: ["com.manage"] }), /outside com\.example/],
    ["a blob resource", set({ type: "permission", resource: "blob", accept: ["*/*"] }), /resource blob/],
    ["aud and inheritAud together", set({ ...RPC, inheritAud: true }), /both aud and inheritAud/],
    ["neither aud nor inheritAud", set({ ...RPC, aud: undefined }), /needs aud or inheritAud/],
    ["a concrete aud", set({ ...RPC, aud: "did:web:api.example.com#svc" }), /aud must be "\*"/],
    ["an unknown repo action", set({ type: "permission", resource: "repo", collection: ["com.example.post"], action: ["read"] }), /action read/],
    ["a set that isn't main", { lexicon: 1, id: "com.example.sets", defs: { other: set(RPC).defs.main } }, /only the main def/],
  ])("rejects %s", (_, doc, problem) => {
    const problems = permissionSetProblems(doc);
    expect(problems.length).toBe(1);
    expect(problems[0]).toMatch(problem);
  });
});

describe("published permission sets", () => {
  test("every permission set follows the spec", async () => {
    const problems: string[] = [];
    for (const { dir } of DESTINATIONS) {
      for (const file of await lexiconFiles(dir)) {
        const doc = JSON.parse(await readFile(file, "utf8"));
        problems.push(...permissionSetProblems(doc).map((p) => `${file}: ${p}`));
      }
    }
    expect(problems).toEqual([]);
  });

  // HappyView's /admin gate checks a token for exactly this method, so the
  // set has to keep granting it whatever else it grows to include.
  test("dev.happyview.adminFull grants dev.happyview.admin.manage", async () => {
    const doc = JSON.parse(
      await readFile("accounts/happyview.dev/dev/happyview/adminFull.json", "utf8"),
    );
    const lxms = doc.defs.main.permissions.flatMap((p: { lxm?: string[] }) => p.lxm ?? []);
    expect(lxms).toContain("dev.happyview.admin.manage");
  });
});
