#!/usr/bin/env bun
/**
 * Inlines src/shared/prelude.lua blocks into each script under src/at/ and
 * src/software/, and into each job under jobs/ that asks for them,
 * writing complete, runnable Lua to lua/.
 *
 * HappyView v3's `require` reaches only its own `internal.*` modules and
 * installed `happyview.*` library plugins, never a sibling file, so sharing
 * script code at runtime is still impossible and the duplication has to be
 * resolved at build time.
 *
 * An off-the-shelf bundler was rejected (audited 2026-09-04): luabundle and
 * darklua both emit a module-table loader preamble, which costs instructions
 * on every invocation against a hard budget and makes the generated admin gate
 * harder to audit; amalg needs a require that reads package.preload, and the
 * sandbox's require loads only the two module kinds above. See the spec's
 * "Rejected" table.
 */
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

// `src/software` holds the scripts for the software.release.* lexicons the
// registry indexes; they render beside src/at so lexicon, script and output
// paths stay one-to-one.
const SRC_ROOTS = ["src/at", "src/software"];
const JOBS_ROOT = "jobs";
const OUT_ROOT = "lua";
const PRELUDE_PATH = "src/shared/prelude.lua";

const DIRECTIVE = /^--\s*@prelude\s+(.+)$/m;

/**
 * Blocks that pull in others. Ordering is handled by prelude file order, not
 * here: a Lua local must be declared before any function closing over it, so
 * `json` and `failure` come first in the file.
 *
 * `gate` is separate from `failure` so actor.getProfile can take the failure
 * helper WITHOUT the admin gate -- it is the endpoint that reports
 * membership, so gating it on membership is circular.
 */
const IMPLIES: Record<string, string[]> = {
  // Not transitive: `gate` lists `validate` itself because `authority` needs it.
  authority: ["validate"],
  gate: ["failure", "access", "validate", "authority"],
  clickhouse: ["json", "failure", "urlencode"],
  provisioner: ["json", "failure"],
  instance: ["json"],
  jobs: ["failure"],
  plugin: ["validate"],
  // `authority` for happyproto_did: a registry script reads its own state
  // under that DID, so every one of them needs it.
  registry: ["plugin", "authority", "validate"],
};

export function parsePrelude(text: string): Map<string, string> {
  const blocks = new Map<string, string>();
  let name: string | null = null;
  let body: string[] = [];

  for (const line of text.split("\n")) {
    const open = line.match(/^--\s*@block\s+([A-Za-z0-9_]+)\s*$/);
    if (open) {
      if (name) throw new Error(`prelude: block "${name}" is unterminated`);
      name = open[1];
      body = [];
      continue;
    }
    if (/^--\s*@endblock\s*$/.test(line)) {
      if (!name) throw new Error("prelude: @endblock without a matching @block");
      blocks.set(name, body.join("\n").trim());
      name = null;
      continue;
    }
    if (name) body.push(line);
  }

  if (name) throw new Error(`prelude: block "${name}" is unterminated`);
  return blocks;
}

export function parseDirective(text: string, path: string): string[] {
  const match = text.match(DIRECTIVE);
  if (!match) {
    throw new Error(
      `${path}: no "-- @prelude" directive. Every script must declare its ` +
        `blocks explicitly; inferring them from the body would fail ` +
        `confusingly the moment someone adds a helper.`,
    );
  }
  return match[1]
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function expand(names: string[], order: string[]): string[] {
  const wanted = new Set<string>();
  for (const name of names) {
    wanted.add(name);
    for (const implied of IMPLIES[name] ?? []) wanted.add(implied);
  }
  for (const name of wanted) {
    if (!order.includes(name)) {
      throw new Error(
        `unknown prelude block "${name}"; known blocks: ${order.join(", ")}`,
      );
    }
  }
  // Prelude file order, never directive order.
  return order.filter((name) => wanted.has(name));
}

export function render(
  sourcePath: string,
  blockBodies: string[],
  sourceText: string,
): string {
  const match = sourceText.match(DIRECTIVE);
  if (!match || match.index === undefined) {
    throw new Error(`${sourcePath}: cannot render without a @prelude directive`);
  }

  // Split at the directive so the script's own doc comment stays at the TOP of
  // the generated file. Emitting it after the prelude would bury the one part
  // that explains what the endpoint is under a hundred lines of boilerplate.
  const header = sourceText.slice(0, match.index).trim();
  const body = sourceText.slice(match.index + match[0].length).trim();

  const parts = [
    `-- Generated from ${sourcePath} — do not edit.`,
    "-- Run `bun run gen` after changing the source or src/shared/prelude.lua.",
    "",
  ];
  if (header) parts.push(header, "");
  for (const block of blockBodies) parts.push(block, "");
  parts.push(body, "");

  return parts.join("\n");
}

async function walk(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (cause) {
    // A root nobody has written a script under yet is not an error.
    if ((cause as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    throw cause;
  }
  // Sorted, so output is deterministic across filesystems.
  entries.sort((a, b) => a.name.localeCompare(b.name));

  const out: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else if (entry.name.endsWith(".lua")) out.push(full);
  }
  return out;
}

/**
 * Renders every script under the source roots into lua/, and every job into
 * lua/jobs/. A job without a directive is copied as it is: deploying it never
 * needed a prelude, and a directive-less job should not start failing here.
 * Paths are resolved under `root` so tests can generate a fixture tree.
 */
export async function generate(root = "."): Promise<number> {
  const at = (path: string) => join(root, path);
  const prelude = parsePrelude(await readFile(at(PRELUDE_PATH), "utf8"));
  const order = [...prelude.keys()];

  await rm(at(OUT_ROOT), { recursive: true, force: true });

  let written = 0;

  async function emit(source: string, target: string, copyIfBare: boolean): Promise<void> {
    const text = await readFile(at(source), "utf8");
    await mkdir(dirname(at(target)), { recursive: true });
    if (copyIfBare && !DIRECTIVE.test(text)) {
      await writeFile(at(target), text, "utf8");
    } else {
      const names = expand(parseDirective(text, source), order);
      const bodies = names.map((name) => prelude.get(name)!);
      await writeFile(at(target), render(source, bodies, text), "utf8");
    }
    written += 1;
  }

  for (const srcRoot of SRC_ROOTS) {
    for (const file of await walk(at(srcRoot))) {
      const source = relative(root, file);
      await emit(source, join(OUT_ROOT, relative("src", source)), false);
    }
  }

  for (const file of await walk(at(JOBS_ROOT))) {
    const source = relative(root, file);
    await emit(source, join(OUT_ROOT, source), true);
  }

  return written;
}

async function main(): Promise<void> {
  const written = await generate();

  if (written === 0) {
    // A zero-file run exiting 0 would let `lint` pass having linted no Lua at
    // all -- green, and worthless.
    console.error(`gen: wrote no files. Are ${SRC_ROOTS.join(" and ")} empty?`);
    process.exit(1);
  }

  console.log(`gen: wrote ${written} script(s) to ${OUT_ROOT}/`);
}

if (import.meta.main) await main();
