import { describe, expect, test } from "bun:test";
import { expand, parseDirective, parsePrelude, render } from "./gen";

const PRELUDE = `
-- @block space
local S = 0
-- @endblock

-- @block failure
local A = 1
-- @endblock

-- @block gate
local G = 9
-- @endblock

-- @block config
local B = 2
-- @endblock

-- @block urlencode
local C = 3
-- @endblock

-- @block clickhouse
local D = 4
-- @endblock
`;

describe("parsePrelude", () => {
  test("returns block bodies in file order", () => {
    const blocks = parsePrelude(PRELUDE);
    expect([...blocks.keys()]).toEqual([
      "space", "failure", "gate", "config", "urlencode", "clickhouse",
    ]);
    expect(blocks.get("failure")).toBe("local A = 1");
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
  const order = ["space", "failure", "gate", "config", "urlencode", "clickhouse"];

  test("clickhouse implies config and urlencode", () => {
    expect(expand(["clickhouse"], order)).toEqual([
      "config",
      "urlencode",
      "clickhouse",
    ]);
  });

  test("emits in prelude order, not directive order", () => {
    expect(expand(["clickhouse", "gate"], order)).toEqual([
      "space",
      "failure",
      "gate",
      "config",
      "urlencode",
      "clickhouse",
    ]);
  });

  test("gate implies space and failure", () => {
    expect(expand(["gate"], order)).toEqual(["space", "failure", "gate"]);
  });

  test("space and failure do NOT pull in the gate", () => {
    // actor.getProfile reports membership, so gating it on membership would be
    // circular. It takes these two blocks and must not receive denied().
    expect(expand(["space", "failure"], order)).toEqual(["space", "failure"]);
  });

  test("an unknown block names the offender", () => {
    expect(() => expand(["nope"], order)).toThrow(/nope/);
  });

  test("deduplicates", () => {
    expect(expand(["config", "config"], order)).toEqual(["config"]);
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
      "-- @prelude failure\n\nfunction handle() end\n",
    );
    expect(out).toStartWith(
      "-- Generated from src/at/happyproto/fleet/getX.lua — do not edit.",
    );
    expect(out).not.toContain("@prelude");
    expect(out).toContain("local A = 1");
    expect(out).toContain("function handle() end");
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
