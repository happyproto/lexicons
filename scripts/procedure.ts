/**
 * Runs one registry procedure as HappyView would: the script is generated
 * from source exactly as `bun run gen` does, then `handle(input, ctx)` runs
 * under Lua 5.4 behind the stubs a test supplies. What the stubs record in
 * `__calls` comes back beside the procedure's answer.
 *
 * Shared by the procedure tests. Not a test file, so importing it registers
 * no tests.
 */
import { test } from "bun:test";
import { readFile } from "node:fs/promises";
import { expand, parseDirective, parsePrelude, render } from "./gen";
import { HARNESS } from "./harness";
import { findLua } from "./lua";

const lua = findLua();
const skipLua = !lua && Boolean(process.env.ALLOW_SKIP_LUA);

/** `test`, or `test.skip` when Lua is absent and that was asked for. */
export const it = skipLua ? test.skip : test;

export async function generated(source: string): Promise<string> {
  const prelude = parsePrelude(await readFile("src/shared/prelude.lua", "utf8"));
  const text = await readFile(source, "utf8");
  const blocks = expand(parseDirective(text, source), [...prelude.keys()]);
  return render(source, blocks.map((name) => prelude.get(name)!), text);
}

export type Run = { out: any; calls: any[] };

export function run(script: string, stubs: string, input: string, ctx: string): Run {
  if (!lua) {
    throw new Error(
      "no lua on PATH, so the procedure was never executed. " +
        "Install Lua (macOS: brew install lua; Ubuntu: apt-get install -y lua5.4). " +
        "To run deliberately without it, set ALLOW_SKIP_LUA=1.",
    );
  }
  const source = [
    HARNESS,
    stubs,
    script,
    `local __out = handle(${input}, ${ctx})`,
    "io.write(__encode({ out = __out, calls = __calls }))",
  ].join("\n\n");
  const result = Bun.spawnSync([lua, "-"], { stdin: new TextEncoder().encode(source) });
  if (result.exitCode !== 0) {
    throw new Error(`lua exited ${result.exitCode}:\n${new TextDecoder().decode(result.stderr)}`);
  }
  const parsed = JSON.parse(new TextDecoder().decode(result.stdout));
  const calls = Array.isArray(parsed.calls) ? parsed.calls : [];
  return { out: parsed.out, calls };
}
