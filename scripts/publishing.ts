import { readdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * An account whose repo this project publishes lexicons into.
 *
 * Every lexicon lives in the one `lexicons/` tree. Each account's run of
 * lexicon-publish selects its own share with `include` and `exclude`, and is
 * published as com.atproto.lexicon.schema records only to that account.
 * `_lexicon.<authority>` DNS must name the account's DID, or lexicon-publish
 * refuses the run. The Deploy workflow's publish-lexicons matrix and plan
 * steps mirror this table, and publishing.test.ts holds them together.
 */
export interface Destination {
  account: string;
  /** What lexicon-publish signs in as: a handle or a DID. */
  identifier: string;
  /** The repo secret holding an app password for the account. */
  secret: string;
  /** The NSID prefixes this account owns. */
  namespaces: string[];
}

export const DESTINATIONS: Destination[] = [
  {
    account: "happyproto.at",
    identifier: "happyproto.at",
    secret: "LEXICON_APP_PASSWORD",
    namespaces: ["at.happyproto"],
  },
  {
    // By DID: happyview.dev's web server answers the handle's .well-known
    // path with the site, so only its DNS record resolves the handle.
    account: "happyview.dev",
    identifier: "did:plc:qneu5uamqs6cug7sjobbaexm",
    secret: "HAPPYVIEW_DEV_LEXICON_APP_PASSWORD",
    namespaces: ["dev.happyview"],
  },
];

/**
 * lexicon-publish's include and exclude inputs for an account. HappyProto, the
 * first, publishes the tree minus every other account's namespaces; each other
 * account publishes only its own.
 */
export function filters(d: Destination): { include: string; exclude: string } {
  if (d === DESTINATIONS[0]) {
    const others = DESTINATIONS.slice(1).flatMap((o) => o.namespaces);
    return { include: "", exclude: others.join(",") };
  }
  return { include: d.namespaces.join(","), exclude: "" };
}

/** Whether a prefix matches an NSID the way lexicon-publish does: by whole segments. */
function matches(nsid: string, prefixes: string): boolean {
  return prefixes
    .split(",")
    .filter((p) => p !== "")
    .some((p) => nsid === p || nsid.startsWith(`${p}.`));
}

/** Whether an account's run of lexicon-publish would publish this NSID. */
export function publishes(d: Destination, nsid: string): boolean {
  const { include, exclude } = filters(d);
  if (include && !matches(nsid, include)) return false;
  return !(exclude && matches(nsid, exclude));
}

/** The account that owns an NSID, by its namespaces. */
export function owner(nsid: string): Destination | undefined {
  return DESTINATIONS.find((d) => d.namespaces.some((ns) => matches(nsid, ns)));
}

export async function lexiconFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await lexiconFiles(full)));
    else if (entry.name.endsWith(".json")) out.push(full);
  }
  return out.sort();
}
