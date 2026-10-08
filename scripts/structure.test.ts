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
    } else if ((word === "ctx" || word === "env") && /^\s*[.[:]/.test(code.slice(at + word.length))) {
      if (!stack.includes("function")) {
        offences.push(`line ${lineOf(code, at)}: reads ${word} at file scope`);
      }
    }
  }
  return offences;
}

/**
 * Scripts that take no gate, each for a stated reason. Everything else under
 * at/happyproto/ must be gated, so a new directory is refused until someone
 * decides which gate it needs, rather than shipping open by default.
 */
const UNGATED: Record<string, string> = {
  // Reports membership, so gating it on membership would be circular.
  "at/happyproto/actor/getProfile": "reports membership",
  // Any signed-in caller; it checks for itself whether they are a customer.
  "at/happyproto/actor/getAccount": "signed-in only, its own check",
};

/** Directory under at/happyproto/ -> the gate its handlers must open with. */
const GATE_FOR_DIR: Record<string, "gate_admin" | "gate_customer"> = {
  fleet: "gate_admin",
  admin: "gate_admin",
  server: "gate_customer",
};

/**
 * The gate a script under this path must open with; "none" for an allowlisted
 * script; "unmapped" for a path nobody has decided about yet, which is itself
 * an offence.
 */
export function requiredGate(path: string): "gate_admin" | "gate_customer" | "none" | "unmapped" {
  const match = path.match(/(?:^|\/)(at\/happyproto\/([^/]+)\/[^/]+?)(?:\.lua)?$/);
  if (!match) return "unmapped";
  if (UNGATED[match[1]]) return "none";
  return GATE_FOR_DIR[match[2]] ?? "unmapped";
}

/**
 * handle() opens with the required gate, in exactly this idiom:
 *
 *   local refused = gate_admin(ctx)
 *   if refused then return refused end
 *
 * and never calls the other gate. First, because anything ahead of it runs
 * for a caller who may be refused. The exact idiom, because a bare
 * `gate_admin(ctx)`, or a result that is stored and never returned, LOOKS
 * gated and admits everyone. And only one gate, because a staff endpoint that
 * also admits customers is a customer endpoint.
 */
export function gateOffences(path: string, text: string): string[] {
  const want = requiredGate(path);
  if (want === "none") return [];
  if (want === "unmapped") {
    return ["is in a directory with no gate mapping; add it to GATE_FOR_DIR or UNGATED"];
  }
  const other = want === "gate_admin" ? "gate_customer" : "gate_admin";
  const code = stripLua(text, true);
  const offences: string[] = [];

  const handle = code.match(HANDLE);
  if (!handle) return ["has no handle(input, ctx) to gate"];
  const body = code.slice(handle.index! + handle[0].length).trimStart();
  const first = new RegExp(
    `^local\\s+(\\w+)\\s*=\\s*${want}\\s*\\(\\s*ctx\\s*\\)\\s*;?\\s*` +
      `if\\s+\\1\\s+then\\s+return\\s+\\1\\s*;?\\s*end\\b`,
  );
  if (!first.test(body)) {
    offences.push(
      `handle does not open with "local refused = ${want}(ctx)" then "if refused then return refused end"`,
    );
  }
  if (new RegExp(`(^|[^\\w.:])${other}\\s*\\(`).test(stripLua(text))) {
    offences.push(`calls ${other} as well as ${want}`);
  }
  return offences;
}

/**
 * Customer endpoints never reach ClickHouse. It holds the whole fleet's
 * telemetry, and query() answers with whatever SQL it is handed; the
 * customer surface is the provisioner, scoped to the caller.
 */
export function clickhouseOffences(path: string, text: string): string[] {
  const customerFacing =
    /(^|\/)at\/happyproto\/server\//.test(path) ||
    /(^|\/)at\/happyproto\/actor\/getAccount(\.lua)?$/.test(path);
  if (!customerFacing) return [];
  return /(^|[^\w.:])query\s*\(/.test(stripLua(text))
    ? ["calls query(): customer endpoints must not read ClickHouse"]
    : [];
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
 * Provisioner writes come only from procedures, and a procedure that writes
 * takes an idempotencyKey and forwards it. A query is a GET: browsers, caches
 * and link previews fetch it freely, so it must never change anything. And
 * without the key a double-click or a network retry creates a second tenant,
 * or answers SlugTaken for the caller's own first request.
 */
export function idempotencyOffences(lexicon: any, text: string): string[] {
  const writes = provisionerCalls(text).filter(isWrite);
  if (writes.length === 0) return [];
  if (lexicon?.defs?.main?.type !== "procedure") {
    return writes.map(
      (args) => `provisioner(${args.slice(0, 3).join(", ")}, ...) writes from a ${lexicon?.defs?.main?.type ?? "non-procedure"}`,
    );
  }

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
    expect(fileScopeOffences("local A = ctx:get_env()\n")).not.toEqual([]);
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

  test("the gate is the first statement of handle, in the exact idiom", () => {
    const fleet = "src/at/happyproto/fleet/getX.lua";
    const server = "src/at/happyproto/server/getX.lua";
    const ok = "function handle(input, ctx)\n  local refused = gate_admin(ctx)\n  if refused then return refused end\n  return {}\nend\n";
    const customer = ok.replace("gate_admin", "gate_customer");

    expect(gateOffences(fleet, ok)).toEqual([]);
    expect(gateOffences("src/at/happyproto/admin/x.lua", ok)).toEqual([]);
    expect(gateOffences(server, customer)).toEqual([]);
    // Any local name will do, as long as it is the one returned.
    expect(gateOffences(fleet, ok.replaceAll("refused", "denied"))).toEqual([]);

    // No gate.
    expect(gateOffences(fleet, "function handle(input, ctx)\n  return {}\nend\n")).not.toEqual([]);
    // A bare call: the result is thrown away, so everyone is admitted.
    expect(
      gateOffences(fleet, "function handle(input, ctx)\n  gate_admin(ctx)\n  return {}\nend\n"),
    ).not.toEqual([]);
    // Stored but never returned.
    expect(
      gateOffences(fleet, "function handle(input, ctx)\n  local refused = gate_admin(ctx)\n  return {}\nend\n"),
    ).not.toEqual([]);
    // Stored, but a different name is checked or returned.
    expect(gateOffences(fleet, ok.replace("if refused then", "if r then"))).not.toEqual([]);
    expect(gateOffences(fleet, ok.replace("return refused end", "return nil end"))).not.toEqual([]);
    // Gated, but not first.
    expect(
      gateOffences(fleet, ok.replace("  local refused", "  local x = 1\n  local refused")),
    ).not.toEqual([]);
    // The wrong gate for the directory.
    expect(gateOffences(server, ok)).not.toEqual([]);
    expect(gateOffences(fleet, customer)).not.toEqual([]);
    // Both gates.
    expect(
      gateOffences(fleet, ok.replace("  return {}", "  gate_customer(ctx)\n  return {}")),
    ).not.toEqual([]);
    // A gate in a comment is not a gate.
    expect(
      gateOffences(fleet, "function handle(input, ctx)\n  -- local refused = gate_admin(ctx)\n  -- if refused then return refused end\n  return {}\nend\n"),
    ).not.toEqual([]);
  });

  test("every directory is gated unless the script is allowlisted", () => {
    const open = "function handle(input, ctx)\n  return {}\nend\n";
    expect(requiredGate("src/at/happyproto/fleet/getX.lua")).toBe("gate_admin");
    expect(requiredGate("src/at/happyproto/admin/getX.lua")).toBe("gate_admin");
    expect(requiredGate("src/at/happyproto/server/getX.lua")).toBe("gate_customer");
    expect(gateOffences("src/at/happyproto/actor/getProfile.lua", open)).toEqual([]);
    expect(gateOffences("src/at/happyproto/actor/getAccount.lua", open)).toEqual([]);
    // Another actor.* script is not allowlisted just by living beside them.
    expect(gateOffences("src/at/happyproto/actor/getSecrets.lua", open)).not.toEqual([]);
    // A directory nobody has mapped is refused, not left open.
    expect(gateOffences("src/at/happyproto/billing/getInvoice.lua", open)).not.toEqual([]);
    expect(requiredGate("src/at/happyproto/billing/getInvoice.lua")).toBe("unmapped");
  });

  test("customer endpoints never query ClickHouse", () => {
    const reads = 'function handle(input, ctx)\n  local rows = query(ctx, "SELECT 1")\nend\n';
    expect(clickhouseOffences("src/at/happyproto/server/listX.lua", reads)).not.toEqual([]);
    expect(clickhouseOffences("src/at/happyproto/actor/getAccount.lua", reads)).not.toEqual([]);
    expect(clickhouseOffences("src/at/happyproto/fleet/getX.lua", reads)).toEqual([]);
    // Neither a field nor a method named query, nor a comment, is ClickHouse.
    expect(
      clickhouseOffences(
        "src/at/happyproto/server/listX.lua",
        "-- query(ctx, sql)\nlocal x = db.query(1)\nlocal y = h:query(2)\n",
      ),
    ).toEqual([]);
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
    // Reads need no key, and a query may read.
    const query = { defs: { main: { type: "query" } } };
    expect(idempotencyOffences(lexicon, 'provisioner(ctx, "GET", "/v1/plans")\n')).toEqual([]);
    expect(idempotencyOffences(query, 'provisioner(ctx, "GET", "/v1/plans")\n')).toEqual([]);
    // A query never writes, key or no key.
    expect(idempotencyOffences(query, good)).not.toEqual([]);
    expect(
      idempotencyOffences(query, 'provisioner(ctx, "DELETE", "/v1/tenants/" .. input.id)\n'),
    ).not.toEqual([]);
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

  test("provisioner writes come only from procedures, with an idempotency key", async () => {
    const offenders: string[] = [];
    for (const script of await walk("src/at", ".lua")) {
      const lexicon = await lexiconFor(script);
      if (!lexicon) continue;
      const text = await readFile(script, "utf8");
      for (const o of idempotencyOffences(lexicon, text)) offenders.push(`${script}: ${o}`);
    }
    expect(offenders).toEqual([]);
  });

  test("no customer endpoint queries ClickHouse", async () => {
    const offenders: string[] = [];
    for (const script of await walk("src/at", ".lua")) {
      const text = await readFile(script, "utf8");
      for (const o of clickhouseOffences(script, text)) offenders.push(`${script}: ${o}`);
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
