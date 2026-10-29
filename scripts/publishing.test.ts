import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { DESTINATIONS, filters, lexiconFiles, owner, publishes } from "./publishing";

async function ids(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const file of await lexiconFiles(dir)) {
    out.push(JSON.parse(await readFile(file, "utf8")).id);
  }
  return out;
}

const [HAPPYPROTO, HAPPYVIEW] = DESTINATIONS;

type Step = { uses?: string; with?: Record<string, string> };
type Job = { steps: Step[]; strategy?: { matrix: { include: Record<string, string>[] } } };

async function workflow(): Promise<Record<string, Job>> {
  const text = await readFile(".github/workflows/deploy.yml", "utf8");
  return (Bun.YAML.parse(text) as { jobs: Record<string, Job> }).jobs;
}

describe("publish destinations", () => {
  test("namespaces don't overlap between accounts", () => {
    const all = DESTINATIONS.flatMap((d) => d.namespaces);
    for (const a of all) {
      for (const b of all) {
        if (a !== b) expect(`${a}.`.startsWith(`${b}.`)).toBe(false);
      }
    }
  });

  test("dev.happyview goes only to happyview.dev", () => {
    expect(publishes(HAPPYVIEW, "dev.happyview.adminFull")).toBe(true);
    expect(publishes(HAPPYPROTO, "dev.happyview.adminFull")).toBe(false);
  });

  test("at.happyproto never goes to happyview.dev", () => {
    expect(publishes(HAPPYPROTO, "at.happyproto.registry.project")).toBe(true);
    expect(publishes(HAPPYVIEW, "at.happyproto.registry.project")).toBe(false);
  });

  // lexicon-publish matches prefixes by whole segments, and so must the test.
  test("a namespace matches whole segments", () => {
    expect(owner("dev.happyviewer.thing")).toBeUndefined();
    expect(publishes(HAPPYVIEW, "dev.happyviewer.thing")).toBe(false);
  });

  test("every lexicon has an owner and is published to it alone", async () => {
    const wrong: string[] = [];
    for (const id of await ids("lexicons")) {
      const to = DESTINATIONS.filter((d) => publishes(d, id)).map((d) => d.account);
      if (to.length !== 1 || to[0] !== owner(id)?.account) {
        wrong.push(`${id}: owner ${owner(id)?.account}, published to [${to.join(", ")}]`);
      }
    }
    expect(wrong).toEqual([]);
  });

  // vendor/ is upstream's and never published, so it must not hold a copy of
  // a lexicon one of these accounts publishes.
  test("vendored lexicons belong to no account", async () => {
    expect((await ids("vendor/lexicons")).filter((id) => owner(id))).toEqual([]);
  });
});

describe("deploy workflow", () => {
  test("publishes each account with its filters and its own password", async () => {
    const job = (await workflow())["publish-lexicons"];
    expect(job.strategy?.matrix.include).toEqual(
      DESTINATIONS.map((d) => {
        const { include, exclude } = filters(d);
        return {
          account: d.account,
          identifier: d.identifier,
          "include-prefixes": include,
          "exclude-prefixes": exclude,
          secret: d.secret,
        };
      }),
    );
    const step = job.steps.find((s) => s.uses?.startsWith("happyproto/actions/lexicon-publish@"));
    expect(step?.with).toEqual({
      identifier: "${{ matrix.identifier }}",
      include: "${{ matrix.include-prefixes }}",
      exclude: "${{ matrix.exclude-prefixes }}",
      password: "${{ secrets[matrix.secret] }}",
    });
  });

  test("the pull request plan dry-runs every account", async () => {
    const steps = (await workflow()).plan.steps.filter((s) =>
      s.uses?.startsWith("happyproto/actions/lexicon-publish@"),
    );
    expect(steps.map((s) => s.with)).toEqual(
      DESTINATIONS.map((d) => {
        const { include, exclude } = filters(d);
        return {
          identifier: d.identifier,
          ...(include && { include }),
          ...(exclude && { exclude }),
          "dry-run": "true",
        };
      }),
    );
  });
});
