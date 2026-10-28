import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { DESTINATIONS, destinationFor, lexiconFiles } from "./publishing";

async function ids(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const file of await lexiconFiles(dir)) {
    out.push(JSON.parse(await readFile(file, "utf8")).id);
  }
  return out;
}

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

  test("routes each namespace to its account", () => {
    expect(destinationFor("at.happyproto.registry.project")?.account).toBe("happyproto.at");
    expect(destinationFor("dev.happyview.adminFull")?.account).toBe("happyview.dev");
    expect(destinationFor("dev.happyviewer.thing")).toBeUndefined();
    expect(destinationFor("software.release.project")).toBeUndefined();
  });

  // lexicon-publish refuses a directory where any authority's _lexicon DNS
  // names another account, so a misplaced file would fail the whole publish.
  test("every lexicon sits in its own account's directory", async () => {
    const misplaced: string[] = [];
    for (const d of DESTINATIONS) {
      for (const id of await ids(d.dir)) {
        if (destinationFor(id) !== d) misplaced.push(`${d.dir}: ${id}`);
      }
    }
    expect(misplaced).toEqual([]);
  });

  // vendor/ is upstream's and never published, so it must not hold a copy of
  // a lexicon one of these accounts publishes.
  test("vendored lexicons belong to no destination", async () => {
    const claimed = (await ids("vendor/lexicons")).filter((id) => destinationFor(id));
    expect(claimed).toEqual([]);
  });
});

describe("deploy workflow", () => {
  test("publishes each destination with its own password", async () => {
    const job = (await workflow())["publish-lexicons"];
    expect(job.strategy?.matrix.include).toEqual(
      DESTINATIONS.map((d) => ({
        account: d.account,
        identifier: d.identifier,
        dir: d.dir,
        secret: d.secret,
      })),
    );
    const step = job.steps.find((s) => s.uses?.startsWith("happyproto/actions/lexicon-publish@"));
    expect(step?.with).toEqual({
      identifier: "${{ matrix.identifier }}",
      "lexicons-dir": "${{ matrix.dir }}",
      password: "${{ secrets[matrix.secret] }}",
    });
  });

  test("the pull request plan dry-runs every destination", async () => {
    const steps = (await workflow()).plan.steps.filter((s) =>
      s.uses?.startsWith("happyproto/actions/lexicon-publish@"),
    );
    expect(steps.map((s) => s.with)).toEqual(
      DESTINATIONS.map((d) => ({
        identifier: d.identifier,
        "lexicons-dir": d.dir,
        "dry-run": "true",
      })),
    );
  });

  // HappyView indexes what it's given. Another account's lexicons are not
  // the instance's to serve, so only lexicons/ and vendor/ go to it.
  test("deploys only HappyProto's and vendored lexicons to HappyView", async () => {
    const jobs = await workflow();
    for (const name of ["plan", "deploy"]) {
      const step = jobs[name].steps.find((s) =>
        s.uses?.startsWith("gamesgamesgamesgamesgames/happyview-actions/deploy@"),
      );
      expect(step?.with?.lexicons.trim().split("\n")).toEqual([
        "lexicons/**/*.json",
        "vendor/lexicons/**/*.json",
      ]);
    }
  });
});
