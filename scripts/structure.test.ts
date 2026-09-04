import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

async function walk(dir: string, ext: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full, ext)));
    else if (entry.name.endsWith(ext)) out.push(full);
  }
  return out;
}

const GATE = /^local function denied\(\)$[\s\S]*?^end$/m;

/**
 * Generated scripts, or a legible failure.
 *
 * `lua/` is build output and is not in the repo, so on a fresh clone it does
 * not exist and `readdir` throws ENOENT with a stack trace that says nothing
 * useful. Say what to do instead.
 *
 * This must FAIL, never skip. A skip here is the vacuous pass this whole
 * mechanism exists to prevent: the suite would go green having inspected no
 * generated output at all.
 */
/**
 * The luac binary, whatever it is called here.
 *
 * Homebrew installs a bare `luac`; Debian and Ubuntu's `lua5.4` package
 * installs `luac5.4` and no unversioned alias. Resolving the name keeps the
 * check working on a laptop and on a runner without either pretending to run.
 */
function findLuac(): string | null {
  // Bun.which, not spawnSync: spawning a binary that does not exist THROWS
  // ENOENT rather than returning a failed result, so a probe loop built on it
  // dies on the first miss instead of trying the next name.
  for (const name of ["luac", "luac5.4", "luac5.3", "luac5.5"]) {
    const found = Bun.which(name);
    if (found) return found;
  }
  return null;
}

async function generated(dir = "lua"): Promise<string[]> {
  try {
    return await walk(dir, ".lua");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException)?.code === "ENOENT") {
      throw new Error(
        `${dir}/ does not exist. It is build output — run \`bun run gen\` ` +
          `before \`bun test\`. (CI does this in the build job.)`,
      );
    }
    throw cause;
  }
}

describe("every script is deployable", () => {
  test("has a paired lexicon", async () => {
    const scripts = await walk("src/at", ".lua");
    expect(scripts.length).toBeGreaterThan(0);

    const missing: string[] = [];
    for (const script of scripts) {
      const nsid = relative("src", script).replace(/\.lua$/, "");
      if (!(await Bun.file(join("lexicons", `${nsid}.json`)).exists())) {
        // A script with no paired lexicon has nothing to derive a trigger
        // from, so it deploys and never runs.
        missing.push(nsid);
      }
    }
    expect(missing).toEqual([]);
  });

  test("declares a prelude directive", async () => {
    for (const script of await walk("src/at", ".lua")) {
      expect(await readFile(script, "utf8")).toMatch(/^--\s*@prelude\s+/m);
    }
  });

  test("no source defines its own copy of a prelude helper", async () => {
    // These belong to the prelude. A local copy would deploy fine and silently
    // diverge, which is the exact failure the generator exists to prevent.
    for (const script of await walk("src/at", ".lua")) {
      const text = await readFile(script, "utf8");
      expect(text).not.toContain("local function denied()");
      expect(text).not.toContain("local function query(");
      expect(text).not.toContain("local function failure(");
      expect(text).not.toContain("local function missing_config(");
    }
  });

  test("every array field declared in a lexicon is wrapped in toarray()", async () => {
    // An empty Lua table is both an empty array and an empty map, and JSON has
    // to pick one -- so a query that matched no rows serialises as {} and the
    // client gets an object where it expected a list:
    //   TypeError: growth.data.byInstance is not iterable
    // toarray() removes the ambiguity at the source, where it belongs, rather
    // than every consumer having to cope with it.
    //
    // The lexicon is the contract, so check against that: every assignment of
    // a field it declares as an array must go through toarray().
    //
    // Flags `field = {}` and `field = someLocal`, and ignores:
    //   - `local field = {}`   an accumulator declaration, not a return value
    //   - `field = anyCall(...)`  toarray(...), and scalars like
    //     `quiet = tonumber(...)` where getSignals has both an array `quiet`
    //     and a distinct scalar `instances.quiet`.
    //
    // "At least one toarray() somewhere" was tried first and is worthless: a
    // script wrapping only its empty-branch return still matched while its
    // real return went out bare.
    //
    // The \b before the lookahead matters. Without it the engine backtracks
    // `toarray` to `toarra`, sees `y` rather than `(`, and the negative
    // lookahead passes -- so every wrapped call reported itself as unwrapped.
    const offenders: string[] = [];

    for (const script of await walk("src/at", ".lua")) {
      const nsid = relative("src", script).replace(/\.lua$/, "");
      const lexiconPath = join("lexicons", `${nsid}.json`);
      if (!(await Bun.file(lexiconPath).exists())) continue;

      const lexicon = JSON.parse(await readFile(lexiconPath, "utf8"));
      const properties = lexicon?.defs?.main?.output?.schema?.properties ?? {};
      const lua = await readFile(script, "utf8");

      for (const [field, schema] of Object.entries<Record<string, unknown>>(
        properties,
      )) {
        if (schema?.type !== "array") continue;

        // (^|[^.\w])field = <value>, where <value> is `{}` or a bare name not
        // followed by `(`.
        const bare = new RegExp(
          `(^|[^.\\w])(local\\s+)?${field}\\s*=\\s*(\\{\\s*\\}|[A-Za-z_]\\w*\\b(?!\\s*\\())`,
          "gm",
        );
        for (const match of lua.matchAll(bare)) {
          if (match[2]) continue; // `local field = {}` is an accumulator
          offenders.push(`${nsid}: ${field} = ${match[3]} is not wrapped in toarray()`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  test("no source interpolates a caller value into SQL", async () => {
    // The one way a caller value reaches a query is query(sql, params), which
    // emits ClickHouse param_<name> arguments. Concatenating `params.x` into
    // SQL text is an injection.
    for (const script of await walk("src/at", ".lua")) {
      const text = await readFile(script, "utf8");
      expect(text).not.toMatch(/\.\.\s*params\./);
      expect(text).not.toMatch(/string\.format\([^)]*params\./);
    }
  });
});

describe("generated output", () => {
  // Mirrors the collector's ALLOW_SKIP_INTEGRATION: a deliberate opt-out is
  // fine, an accidental one is not.
  const skipLuac = Boolean(process.env.ALLOW_SKIP_LUAC);

  test("every admin gate is byte-identical", async () => {
    const files = await generated();
    expect(files.length).toBeGreaterThan(0);

    const gates = new Set<string>();
    for (const file of files) {
      const match = (await readFile(file, "utf8")).match(GATE);
      // Not every script is gated: actor.getProfile reports membership, so
      // gating it on membership would be circular. Those simply contribute
      // nothing to compare.
      if (match) gates.add(match[0]);
    }

    expect(gates.size).toBe(1);
  });

  test("every fleet script IS gated", async () => {
    // The complement of the test above: uniformity is worthless if a script
    // achieves it by having no gate at all.
    for (const file of await generated("lua/at/happyproto/fleet")) {
      expect(await readFile(file, "utf8")).toMatch(GATE);
    }
  });

  test("parses as valid Lua", async () => {
    // luac -p parses without executing. It will not catch a logic error, but
    // it does catch a generator that emitted syntactically broken output,
    // which would otherwise surface only on deploy against the live instance.
    const luac = findLuac();
    if (!luac && skipLuac) {
      console.error("SKIP: no luac on PATH, ALLOW_SKIP_LUAC set");
      return;
    }
    if (!luac) {
      // FAIL, do not skip. A silent skip is how this suite goes green having
      // syntax-checked nothing -- the same trap the collector's
      // TEST_CLICKHOUSE_URL rule exists to close. Opting out is fine; opting
      // out by accident is not.
      throw new Error(
        "no luac on PATH, so no generated script was syntax-checked. " +
          `Install Lua (macOS: brew install lua; Ubuntu: apt-get install -y lua5.4). ` +
          "To run deliberately without it, set ALLOW_SKIP_LUAC=1.",
      );
    }

    for (const file of await generated()) {
      const result = Bun.spawnSync([luac, "-p", file]);
      if (result.exitCode !== 0) {
        throw new Error(
          `${file} does not parse:\n${new TextDecoder().decode(result.stderr)}`,
        );
      }
      expect(result.exitCode).toBe(0);
    }
  });
});
