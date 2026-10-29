import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expand, generate, parseDirective, parsePrelude, render } from "./gen";

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
      "provisioner", "instance", "jobs", "domains", "scaler", "release", "registry",
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
    "provisioner", "instance", "jobs", "release",
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

  test("release implies validate, json and urlencode", () => {
    // urlencode for the PDS requests the registry jobs build.
    expect(expand(["release"], order)).toEqual(["json", "validate", "urlencode", "release"]);
  });

  test("registry implies everything release needs", () => {
    // Implication is one level deep, so registry names release's own blocks.
    expect(expand(["registry"], [...order, "registry"])).toEqual([
      "json", "failure", "validate", "authority", "urlencode", "release", "registry",
    ]);
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

describe("generate", () => {
  async function tree(files: Record<string, string>): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "gen-"));
    for (const [path, text] of Object.entries(files)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), text, "utf8");
    }
    return root;
  }

  const prelude = PRELUDE;

  test("renders src/software beside src/at, at the same relative path", async () => {
    const root = await tree({
      "src/shared/prelude.lua": prelude,
      "src/at/happyproto/a/b.lua": "-- @prelude failure\nreturn 1\n",
      "src/software/release/x.lua": "-- @prelude json\nreturn 2\n",
    });
    try {
      await generate(root);
      const out = await readFile(join(root, "lua/software/release/x.lua"), "utf8");
      expect(out).toContain("local J = 0");
      expect(out).toContain("return 2");
      expect(await Bun.file(join(root, "lua/at/happyproto/a/b.lua")).exists()).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("renders a job with a prelude directive into lua/jobs", async () => {
    const root = await tree({
      "src/shared/prelude.lua": prelude,
      "src/at/happyproto/a/b.lua": "-- @prelude json\nreturn 1\n",
      "jobs/a.b.lua": "-- job.run:a.b\n-- @prelude failure\nreturn 3\n",
    });
    try {
      await generate(root);
      const out = await readFile(join(root, "lua/jobs/a.b.lua"), "utf8");
      expect(out).toContain("local A = 1");
      expect(out).not.toContain("@prelude");
      expect(out).toContain("-- job.run:a.b");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("copies a job with no directive as it is", async () => {
    const text = "-- job.run:c.d\nreturn 4\n";
    const root = await tree({
      "src/shared/prelude.lua": prelude,
      "src/at/happyproto/a/b.lua": "-- @prelude json\nreturn 1\n",
      "jobs/c.d.lua": text,
    });
    try {
      await generate(root);
      expect(await readFile(join(root, "lua/jobs/c.d.lua"), "utf8")).toBe(text);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
