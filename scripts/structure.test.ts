import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { callArguments, findLuac, lineOf, stripLua } from "./lua";

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

const PRELUDE_PATH = "src/shared/prelude.lua";

/** `at/happyproto/fleet/getX` for `src/at/happyproto/fleet/getX.lua`. */
function nsidPath(script: string): string {
  return relative("src", script).replace(/\.lua$/, "");
}

async function lexiconFor(script: string): Promise<any | null> {
  const path = join("lexicons", `${nsidPath(script)}.json`);
  if (!(await Bun.file(path).exists())) return null;
  return JSON.parse(await readFile(path, "utf8"));
}

// ---------------------------------------------------------------------------
// Rules. Each is a pure function from source text to a list of offences, so
// it can be shown to flag a bad fixture before it is trusted to pass the
// real scripts.
// ---------------------------------------------------------------------------

const HANDLE = /^function\s+handle\s*\(\s*input\s*,\s*ctx\s*\)/m;

/** v3 calls `handle(input, ctx)`. Any other signature never sees either. */
export function handleOffences(text: string): string[] {
  return HANDLE.test(stripLua(text)) ? [] : ["does not define function handle(input, ctx)"];
}

/**
 * `ctx.`/`env.` read anywhere outside a function body.
 *
 * The file body runs once when the script loads, before any invocation, so
 * there is no caller and no request there: v3 forbids it. A value captured at
 * file scope would also be shared by every later invocation of that VM.
 *
 * "Outside a function" is outside every `function ... end`, not depth 0: an
 * `if` at file scope is still file scope.
 */
export function fileScopeOffences(text: string): string[] {
  const code = stripLua(text);
  const offences: string[] = [];
  // Each entry is the keyword that opened a still-open block.
  const stack: string[] = [];
  const token = /[A-Za-z_]\w*/g;

  for (const match of code.matchAll(token)) {
    const word = match[0];
    const at = match.index!;
    const before = code[at - 1] ?? "";
    // A field (`t.end` is not legal Lua, but `t.ctx` is) is never a keyword
    // or a bare read of ctx.
    if (before === "." || before === ":") continue;

    if (word === "function" || word === "if" || word === "do" || word === "repeat") {
      stack.push(word);
    } else if (word === "end" || word === "until") {
      stack.pop();
    } else if ((word === "ctx" || word === "env") && /^\s*[.[]/.test(code.slice(at + word.length))) {
      if (!stack.includes("function")) {
        offences.push(`line ${lineOf(code, at)}: reads ${word} at file scope`);
      }
    }
  }
  return offences;
}

/** The gate a script under this path must open with, or null if none. */
export function requiredGate(path: string): "gate_admin" | "gate_customer" | null {
  if (/(^|\/)at\/happyproto\/(fleet|admin)\//.test(path)) return "gate_admin";
  if (/(^|\/)at\/happyproto\/server\//.test(path)) return "gate_customer";
  return null;
}

/**
 * The first statement of handle() is the required gate, and the other gate is
 * never called. First, because anything ahead of it runs for a caller who may
 * be refused; and only one, because a staff endpoint that also admits
 * customers is a customer endpoint.
 */
export function gateOffences(path: string, text: string): string[] {
  const want = requiredGate(path);
  if (!want) return [];
  const other = want === "gate_admin" ? "gate_customer" : "gate_admin";
  const code = stripLua(text, true);
  const offences: string[] = [];

  const handle = code.match(HANDLE);
  if (!handle) return ["has no handle(input, ctx) to gate"];
  const body = code.slice(handle.index! + handle[0].length).trimStart();
  const first = new RegExp(`^(local\\s+\\w+\\s*=\\s*)?${want}\\s*\\(\\s*ctx\\s*\\)`);
  if (!first.test(body)) {
    offences.push(`first statement of handle is not ${want}(ctx)`);
  }
  if (new RegExp(`(^|[^\\w.])${other}\\s*\\(`).test(stripLua(text))) {
    offences.push(`calls ${other} as well as ${want}`);
  }
  return offences;
}

/** Every `provisioner(...)` call, as its argument list. */
function provisionerCalls(text: string): string[][] {
  const code = stripLua(text, true);
  const bare = stripLua(text);
  const calls: string[][] = [];
  for (const match of bare.matchAll(/(^|[^\w.])provisioner\s*\(/g)) {
    calls.push(callArguments(code, match.index! + match[0].length - 1));
  }
  return calls;
}

/** True unless the method argument is literally GET or HEAD. */
function isWrite(args: string[]): boolean {
  return !/^["'](GET|HEAD)["']$/.test(args[1] ?? "");
}

/**
 * A procedure that writes through the provisioner takes an idempotencyKey and
 * forwards it. Without the key a double-click or a network retry creates a
 * second tenant, or answers SlugTaken for the caller's own first request.
 */
export function idempotencyOffences(lexicon: any, text: string): string[] {
  if (lexicon?.defs?.main?.type !== "procedure") return [];
  const writes = provisionerCalls(text).filter(isWrite);
  if (writes.length === 0) return [];

  const offences: string[] = [];
  const schema = lexicon?.defs?.main?.input?.schema ?? {};
  if (!schema.properties?.idempotencyKey) {
    offences.push("input schema has no idempotencyKey");
  } else if (!(schema.required ?? []).includes("idempotencyKey")) {
    offences.push("input schema does not require idempotencyKey");
  }
  for (const args of writes) {
    if (args[4] !== "input.idempotencyKey") {
      offences.push(
        `provisioner(${args.slice(0, 3).join(", ")}, ...) does not pass input.idempotencyKey`,
      );
    }
  }
  return offences;
}

/**
 * The codes provisioner_failure passes through, read from the prelude itself
 * so this rule and the function cannot disagree.
 */
export function passthroughCodes(prelude: string): string[] {
  const table = prelude.match(/local PASSTHROUGH\s*=\s*\{([\s\S]*?)\}/);
  if (!table) throw new Error("prelude: no PASSTHROUGH table in the provisioner block");
  return [...table[1].matchAll(/\b([A-Z][A-Za-z]+)\s*=\s*true/g)].map((m) => m[1]);
}

/** Every error name a source can return. */
export function errorsReturned(text: string, passthrough: string[]): Set<string> {
  const code = stripLua(text, true);
  const bare = stripLua(text);
  const names = new Set<string>();
  for (const m of code.matchAll(/(^|[^\w.])failure\s*\(\s*["']([A-Za-z]+)["']/g)) {
    names.add(m[2]);
  }
  if (/(^|[^\w.])gate_(admin|customer)\s*\(/.test(bare)) {
    names.add("AuthRequired");
    names.add("Forbidden");
  }
  if (/(^|[^\w.])provisioner_failure\s*\(/.test(bare)) {
    for (const name of passthrough) names.add(name);
    names.add("Upstream");
  }
  return names;
}

/** Codes a script can return that its lexicon does not declare. */
export function undeclaredErrorOffences(
  lexicon: any,
  text: string,
  passthrough: string[],
): string[] {
  const declared = new Set<string>(
    (lexicon?.defs?.main?.errors ?? []).map((e: { name: string }) => e.name),
  );
  return [...errorsReturned(text, passthrough)]
    .filter((name) => !declared.has(name))
    .sort()
    .map((name) => `can return ${name}, which the lexicon does not declare`);
}

// ---------------------------------------------------------------------------

describe("each rule flags a bad fixture", () => {
  test("handle(input, ctx)", () => {
    expect(handleOffences("function handle()\nend\n")).not.toEqual([]);
    expect(handleOffences("-- function handle(input, ctx)\n")).not.toEqual([]);
    expect(handleOffences("function handle(input, ctx)\nend\n")).toEqual([]);
  });

  test("no ctx or env at file scope", () => {
    expect(fileScopeOffences("local A = ctx.env.X\n")).not.toEqual([]);
    expect(fileScopeOffences("local A = env.X\n")).not.toEqual([]);
    expect(fileScopeOffences('local A = ctx["env"]\n')).not.toEqual([]);
    // An `if` at file scope is still file scope.
    expect(fileScopeOffences("if true then\n  local A = ctx.env\nend\n")).not.toEqual([]);
    // After a function has closed, file scope resumes.
    expect(
      fileScopeOffences("local function f(ctx)\n  return ctx.env\nend\nlocal B = ctx.x\n"),
    ).toHaveLength(1);

    expect(
      fileScopeOffences(
        [
          "-- ctx.env at file scope, in a comment",
          'local S = "ctx.env"',
          "local function f(ctx)",
          "  if ctx.caller_did then",
          "    for _, v in ipairs(ctx.env) do end",
          "  end",
          "  return ctx.env.X, t.ctx.y",
          "end",
          "function handle(input, ctx) return ctx.env end",
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  test("the gate is the first statement of handle", () => {
    const fleet = "src/at/happyproto/fleet/getX.lua";
    const server = "src/at/happyproto/server/getX.lua";
    const ok = "function handle(input, ctx)\n  local refused = gate_admin(ctx)\n  if refused then return refused end\nend\n";

    expect(gateOffences(fleet, ok)).toEqual([]);
    expect(gateOffences("src/at/happyproto/admin/x.lua", ok)).toEqual([]);
    // No gate.
    expect(gateOffences(fleet, "function handle(input, ctx)\n  return {}\nend\n")).not.toEqual([]);
    // Gated, but not first.
    expect(
      gateOffences(fleet, "function handle(input, ctx)\n  local x = 1\n  local r = gate_admin(ctx)\nend\n"),
    ).not.toEqual([]);
    // The wrong gate for the directory.
    expect(gateOffences(server, ok)).not.toEqual([]);
    // Both gates.
    expect(
      gateOffences(fleet, ok.replace("end\nend", "end\n  gate_customer(ctx)\nend")),
    ).not.toEqual([]);
    // A gate in a comment is not a gate.
    expect(
      gateOffences(fleet, "function handle(input, ctx)\n  -- gate_admin(ctx)\n  return {}\nend\n"),
    ).not.toEqual([]);
    // actor.* takes no gate here.
    expect(gateOffences("src/at/happyproto/actor/getX.lua", "function handle(input, ctx) end")).toEqual([]);
  });

  test("procedures forward the idempotency key", () => {
    const lexicon = {
      defs: {
        main: {
          type: "procedure",
          input: {
            schema: {
              required: ["idempotencyKey"],
              properties: { idempotencyKey: { type: "string" } },
            },
          },
        },
      },
    };
    const good = 'local s, b = provisioner(ctx, "POST", "/v1/tenants", { slug = input.slug }, input.idempotencyKey)\n';
    expect(idempotencyOffences(lexicon, good)).toEqual([]);

    // The key is not forwarded.
    expect(
      idempotencyOffences(lexicon, 'provisioner(ctx, "POST", "/v1/tenants", { a = f(1, 2) })\n'),
    ).not.toEqual([]);
    // The lexicon does not take one.
    const keyless = structuredClone(lexicon) as any;
    keyless.defs.main.input.schema = { properties: {} };
    expect(idempotencyOffences(keyless, good)).not.toEqual([]);
    // A method that is not a literal is treated as a write.
    expect(idempotencyOffences(lexicon, "provisioner(ctx, method, path)\n")).not.toEqual([]);
    // Reads need no key, and neither do queries.
    expect(idempotencyOffences(lexicon, 'provisioner(ctx, "GET", "/v1/plans")\n')).toEqual([]);
    expect(
      idempotencyOffences({ defs: { main: { type: "query" } } }, 'provisioner(ctx, "GET", "/v1/plans")\n'),
    ).toEqual([]);
    // provisioner_failure is not a provisioner call.
    expect(idempotencyOffences(lexicon, "return provisioner_failure(s, b)\n")).toEqual([]);
  });

  test("every returnable error is declared", () => {
    const lexicon = { defs: { main: { errors: [{ name: "Upstream" }] } } };
    expect(undeclaredErrorOffences(lexicon, 'return failure("Upstream", e)\n', [])).toEqual([]);
    expect(undeclaredErrorOffences(lexicon, 'return failure("NotFound", e)\n', [])).not.toEqual([]);
    expect(undeclaredErrorOffences(lexicon, "local r = gate_admin(ctx)\n", [])).not.toEqual([]);
    expect(
      undeclaredErrorOffences(lexicon, "return provisioner_failure(s, b)\n", ["SlugTaken"]),
    ).toEqual(["can return SlugTaken, which the lexicon does not declare"]);
    // A failure() in a comment returns nothing.
    expect(undeclaredErrorOffences(lexicon, '-- failure("NotFound", e)\n', [])).toEqual([]);
  });

  test("the passthrough codes are read from the prelude", () => {
    expect(
      passthroughCodes("local PASSTHROUGH = {\n  SlugTaken = true,\n  NotFound = true,\n}\n"),
    ).toEqual(["SlugTaken", "NotFound"]);
  });
});

describe("every script is deployable", () => {
  test("has a paired lexicon", async () => {
    const scripts = await walk("src/at", ".lua");
    expect(scripts.length).toBeGreaterThan(0);

    const missing: string[] = [];
    for (const script of scripts) {
      if (!(await lexiconFor(script))) {
        // A script with no paired lexicon has nothing to derive a trigger
        // from, so it deploys and never runs.
        missing.push(nsidPath(script));
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
    // The list is every function the prelude defines, so a new helper is
    // covered the moment it is added.
    const prelude = await readFile(PRELUDE_PATH, "utf8");
    const helpers = [...prelude.matchAll(/^\s*local function (\w+)\(/gm)].map((m) => m[1]);
    expect(helpers.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const script of await walk("src/at", ".lua")) {
      const text = await readFile(script, "utf8");
      for (const helper of helpers) {
        if (text.includes(`local function ${helper}(`)) offenders.push(`${script}: ${helper}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("the first statement of every staff and customer handler is its gate", async () => {
    const offenders: string[] = [];
    for (const script of await walk("src/at", ".lua")) {
      const text = await readFile(script, "utf8");
      for (const o of gateOffences(script, text)) offenders.push(`${script}: ${o}`);
    }
    expect(offenders).toEqual([]);
  });

  test("every provisioner write forwards an idempotency key", async () => {
    const offenders: string[] = [];
    for (const script of await walk("src/at", ".lua")) {
      const lexicon = await lexiconFor(script);
      if (!lexicon) continue;
      const text = await readFile(script, "utf8");
      for (const o of idempotencyOffences(lexicon, text)) offenders.push(`${script}: ${o}`);
    }
    expect(offenders).toEqual([]);
  });

  test("every lexicon declares each error its script can return", async () => {
    const passthrough = passthroughCodes(await readFile(PRELUDE_PATH, "utf8"));
    const offenders: string[] = [];
    for (const script of await walk("src/at", ".lua")) {
      const lexicon = await lexiconFor(script);
      if (!lexicon) continue;
      const text = await readFile(script, "utf8");
      for (const o of undeclaredErrorOffences(lexicon, text, passthrough)) {
        offenders.push(`${script}: ${o}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("every array field declared in a lexicon is wrapped in json.to_array()", async () => {
    // An empty Lua table is both an empty array and an empty map, and JSON has
    // to pick one -- so a query that matched no rows serialises as {} and the
    // client gets an object where it expected a list:
    //   TypeError: growth.data.byInstance is not iterable
    // json.to_array() removes the ambiguity at the source, where it belongs,
    // rather than every consumer having to cope with it.
    //
    // The lexicon is the contract, so check against that: every assignment of
    // a field it declares as an array must go through json.to_array().
    //
    // Flags `field = {}` and `field = some.name`, and ignores:
    //   - `local field = {}`   an accumulator declaration, not a return value
    //   - `field = anyCall(...)`  json.to_array(...), and scalars like
    //     `quiet = tonumber(...)` where getSignals has both an array `quiet`
    //     and a distinct scalar `instances.quiet`.
    //
    // "At least one json.to_array() somewhere" was tried first and is
    // worthless: a script wrapping only its empty-branch return still matched
    // while its real return went out bare.
    //
    // The (?![\w.]) matters. The value may be a dotted name, and without it
    // the engine backtracks `json.to_array` to `json`, sees `.` rather than
    // `(`, and the negative lookahead passes -- so every wrapped call would
    // report itself as unwrapped.
    const offenders: string[] = [];

    for (const script of await walk("src/at", ".lua")) {
      const nsid = nsidPath(script);
      const lexicon = await lexiconFor(script);
      if (!lexicon) continue;

      const properties = lexicon?.defs?.main?.output?.schema?.properties ?? {};
      const lua = await readFile(script, "utf8");

      for (const [field, schema] of Object.entries<Record<string, unknown>>(
        properties,
      )) {
        if (schema?.type !== "array") continue;

        // (^|[^.\w])field = <value>, where <value> is `{}` or a bare, possibly
        // dotted, name not followed by `(`.
        const bare = new RegExp(
          `(^|[^.\\w])(local\\s+)?${field}\\s*=\\s*(\\{\\s*\\}|[A-Za-z_]\\w*(?:\\.[A-Za-z_]\\w*)*(?![\\w.])(?!\\s*\\())`,
          "gm",
        );
        for (const match of lua.matchAll(bare)) {
          if (match[2]) continue; // `local field = {}` is an accumulator
          offenders.push(`${nsid}: ${field} = ${match[3]} is not wrapped in json.to_array()`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  test("no source interpolates a caller value into SQL", async () => {
    // The one way a caller value reaches a query is query(ctx, sql, params),
    // which emits ClickHouse param_<name> arguments. Concatenating `input.x`
    // (or a `params.x` built from it) into SQL text is an injection.
    for (const script of await walk("src/at", ".lua")) {
      const text = await readFile(script, "utf8");
      expect(text).not.toMatch(/\.\.\s*(params|input)\./);
      expect(text).not.toMatch(/string\.format\([^)]*(params|input)\./);
    }
  });
});

describe("generated output", () => {
  // Mirrors the collector's ALLOW_SKIP_INTEGRATION: a deliberate opt-out is
  // fine, an accidental one is not.
  const skipLuac = Boolean(process.env.ALLOW_SKIP_LUAC);

  test("every script defines handle(input, ctx)", async () => {
    const files = await generated();
    expect(files.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const file of files) {
      for (const o of handleOffences(await readFile(file, "utf8"))) offenders.push(`${file}: ${o}`);
    }
    expect(offenders).toEqual([]);
  });

  test("no script reads ctx or env at file scope", async () => {
    // Checked on the generated output, so the prelude blocks are covered too.
    const offenders: string[] = [];
    for (const file of await generated()) {
      for (const o of fileScopeOffences(await readFile(file, "utf8"))) {
        offenders.push(`${file}: ${o}`);
      }
    }
    expect(offenders).toEqual([]);
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
