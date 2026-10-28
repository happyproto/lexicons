import { readdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * An account whose repo this project publishes lexicons into.
 *
 * Every NSID under `namespaces` lives in `dir` and is published only to this
 * account, as com.atproto.lexicon.schema records. `_lexicon.<authority>` DNS
 * must name `identifier`'s DID, or lexicon-publish refuses the whole directory.
 * The Deploy workflow's publish-lexicons matrix mirrors this table, and
 * publishing.test.ts holds the two together.
 */
export interface Destination {
  account: string;
  /** What lexicon-publish signs in as: a handle or a DID. */
  identifier: string;
  dir: string;
  /** The repo secret holding an app password for the account. */
  secret: string;
  namespaces: string[];
}

export const DESTINATIONS: Destination[] = [
  {
    account: "happyproto.at",
    identifier: "happyproto.at",
    dir: "lexicons",
    secret: "LEXICON_APP_PASSWORD",
    namespaces: ["at.happyproto"],
  },
  {
    // By DID: happyview.dev's web server answers the handle's .well-known
    // path with the site, so only its DNS record resolves the handle.
    account: "happyview.dev",
    identifier: "did:plc:qneu5uamqs6cug7sjobbaexm",
    dir: "accounts/happyview.dev",
    secret: "HAPPYVIEW_DEV_LEXICON_APP_PASSWORD",
    namespaces: ["dev.happyview"],
  },
];

export function destinationFor(nsid: string): Destination | undefined {
  return DESTINATIONS.find((d) => d.namespaces.some((ns) => nsid.startsWith(`${ns}.`)));
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
