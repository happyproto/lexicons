import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { expand, parseDirective, parsePrelude, render } from "./gen";

const PRELUDE = `
-- @block json
local J = 0
-- @endblock

-- @block failure
local A = 1
-- @endblock

-- @block validate
local V = 2
-- @endblock

-- @block gate
local G = 3
-- @endblock

-- @block clickhouse
local C = 4
-- @endblock

-- @block provisioner
local P = 5
-- @endblock

-- @block instance
local I = 6
-- @endblock
`;

describe("parsePrelude", () => {
  test("returns block bodies in file order", () => {
    const blocks = parsePrelude(PRELUDE);
    expect([...blocks.keys()]).toEqual([
      "json", "failure", "validate", "gate", "clickhouse", "provisioner", "instance",
    ]);
    expect(blocks.get("failure")).toBe("local A = 1");
  });

  test("the real prelude declares the v3 blocks in emit order", async () => {
    // File order IS emit order, so this pins it: a block closing over another
    // must come after it.
    const blocks = parsePrelude(await readFile("src/shared/prelude.lua", "utf8"));
    expect([...blocks.keys()]).toEqual([
      "json", "failure", "validate", "access", "authority", "gate", "urlencode", "clickhouse",
      "provisioner", "instance", "jobs", "plugin",
    ]);
  });

  test("rejects an unterminated block", () => {
    expect(() => parsePrelude("-- @block gate\nlocal A = 1\n")).toThrow(/unterminated/i);
  });

  test("rejects an endblock with no block", () => {
    expect(() => parsePrelude("-- @endblock\n")).toThrow(/@endblock/);
  });
});

describe("parseDirective", () => {
  test("reads a comma-separated list", () => {
    expect(parseDirective("-- @prelude gate, clickhouse\n\nbody", "x.lua")).toEqual([
      "gate",
      "clickhouse",
    ]);
  });

  test("a missing directive is an error naming the file", () => {
    expect(() => parseDirective("function handle() end\n", "x.lua")).toThrow(/x\.lua/);
  });
});

describe("expand", () => {
  const order = [
    "json", "failure", "validate", "access", "authority", "gate", "urlencode", "clickhouse",
    "provisioner", "instance", "jobs",
  ];

  test("gate implies failure, access, validate and authority", () => {
    expect(expand(["gate"], order)).toEqual(["failure", "validate", "access", "authority", "gate"]);
  });

  test("authority implies validate, and stands without the gate", () => {
    // getProfile derives the admin space without taking the gate.
    expect(expand(["authority"], order)).toEqual(["validate", "authority"]);
  });

  test("clickhouse implies json, failure and urlencode", () => {
    expect(expand(["clickhouse"], order)).toEqual(["json", "failure", "urlencode", "clickhouse"]);
  });

  test("provisioner implies json and failure", () => {
    expect(expand(["provisioner"], order)).toEqual(["json", "failure", "provisioner"]);
  });

  test("instance implies json", () => {
    expect(expand(["instance"], order)).toEqual(["json", "instance"]);
  });

  test("jobs implies failure", () => {
    expect(expand(["jobs"], order)).toEqual(["failure", "jobs"]);
  });

  test("emits in prelude order, not directive order", () => {
    expect(expand(["instance", "provisioner", "validate", "gate"], order)).toEqual([
      "json",
      "failure",
      "validate",
      "access",
      "authority",
      "gate",
      "provisioner",
      "instance",
    ]);
  });

  test("failure does NOT pull in the gate", () => {
    // actor.getProfile reports membership, so gating it on membership would be
    // circular. It takes failure and must not receive the gate.
    expect(expand(["failure", "json"], order)).toEqual(["json", "failure"]);
  });

  test("access stands alone, so getProfile can take it without the gate", () => {
    expect(expand(["access", "failure"], order)).toEqual(["failure", "access"]);
  });

  test("an unknown block names the offender", () => {
    expect(() => expand(["nope"], order)).toThrow(/nope/);
  });

  test("the v2 blocks are gone", () => {
    // urlencode came back in v3 as a block of its own; space and config did not.
    for (const old of ["space", "config"]) {
      expect(() => expand([old], order)).toThrow(new RegExp(old));
    }
  });

  test("deduplicates", () => {
    expect(expand(["json", "json"], order)).toEqual(["json"]);
  });

  test("failure alone pulls in nothing else", () => {
    expect(expand(["failure"], order)).toEqual(["failure"]);
  });
});

describe("render", () => {
  test("banner names the source and strips the directive", () => {
    const out = render(
      "src/at/happyproto/fleet/getX.lua",
      ["local A = 1"],
      "-- @prelude failure\n\nfunction handle(input, ctx) end\n",
    );
    expect(out).toStartWith(
      "-- Generated from src/at/happyproto/fleet/getX.lua — do not edit.",
    );
    expect(out).not.toContain("@prelude");
    expect(out).toContain("local A = 1");
    expect(out).toContain("function handle(input, ctx) end");
  });

  test("blocks precede the body", () => {
    const out = render("src/x.lua", ["local A = 1"], "-- @prelude failure\nbody\n");
    expect(out.indexOf("local A = 1")).toBeLessThan(out.indexOf("body"));
  });

  test("output is deterministic", () => {
    const args = ["src/x.lua", ["local A = 1"], "-- @prelude failure\nbody\n"] as const;
    expect(render(...args)).toBe(render(...args));
  });

  test("a leading file comment survives ahead of the directive", () => {
    const out = render(
      "src/x.lua",
      ["local A = 1"],
      "-- at.happyproto.fleet.getX\n--\n-- What it does.\n\n-- @prelude failure\n\nfunction handle() end\n",
    );
    expect(out).toContain("-- What it does.");
    expect(out).not.toContain("@prelude");
    // The script's own doc comment must stay at the top. Emitting it after the
    // prelude would bury the one part explaining what the endpoint is.
    expect(out.indexOf("-- What it does.")).toBeLessThan(out.indexOf("local A = 1"));
    expect(out.indexOf("local A = 1")).toBeLessThan(out.indexOf("function handle()"));
  });
});
