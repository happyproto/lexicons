import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Lexicons } from "@atproto/lexicon";

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else if (entry.name.endsWith(".json")) out.push(full);
  }
  return out;
}

const ROOTS = ["lexicons", "vendor/lexicons"];

async function lexiconFiles(): Promise<string[]> {
  return (await Promise.all(ROOTS.map(walk))).flat().sort();
}

describe("lexicons", () => {
  test("every file loads as a lexicon document", async () => {
    const files = await lexiconFiles();
    expect(files.length).toBeGreaterThan(0);

    const lexicons = new Lexicons();
    const problems: string[] = [];
    for (const file of files) {
      try {
        lexicons.add(JSON.parse(await readFile(file, "utf8")));
      } catch (cause) {
        problems.push(`${file}: ${(cause as Error).message}`);
      }
    }
    expect(problems).toEqual([]);
  });

  test("every lexicon's id matches its path", async () => {
    const mismatched: string[] = [];
    for (const file of await lexiconFiles()) {
      const root = ROOTS.find((r) => file.startsWith(`${r}/`))!;
      const want = file.slice(root.length + 1).replace(/\.json$/, "").replaceAll("/", ".");
      const { id } = JSON.parse(await readFile(file, "utf8"));
      if (id !== want) mismatched.push(`${file}: ${id}`);
    }
    expect(mismatched).toEqual([]);
  });

  // Blobs are verified by their CIDs, so a checksum field would be a second,
  // weaker integrity claim that a client might trust instead.
  test("no plugin or registry lexicon mentions a checksum", async () => {
    const offenders: string[] = [];
    for (const dir of ["lexicons/at/happyproto/plugin", "lexicons/at/happyproto/registry"]) {
      for (const file of await walk(dir)) {
        if (/checksum/i.test(await readFile(file, "utf8"))) offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});
