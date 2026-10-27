/**
 * The registry, end to end, on a real HappyView: a plugin project published
 * as software.release records reaches the indexers through the firehose, its
 * publication, changelog and blobs are fetched from the publisher's own PDS,
 * and the read API answers from what the registry stored.
 *
 * Every record is written to the publisher's PDS first, where the registry's
 * jobs read records and blobs from, and then emitted through the fake
 * Jetstream with the CID the PDS answered. HappyView refuses an event whose
 * record does not hash to its CID, so `recordCid` computing the same CID is
 * also what lets the records the PDS never sees (rewrites and refusals) reach
 * the indexers at all.
 *
 * The gateway's writes need an OAuth session with the caller's PDS, which no
 * test account here has, so the procedures are exercised up to the point of
 * writing: every refusal, and validateOnly. Their writes are unit tested in
 * scripts/gateway.test.ts.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import * as dagCbor from "@ipld/dag-cbor";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import { deflateSync } from "node:zlib";
import pg from "pg";

import { DB_URL } from "./session";
import { call, fails, ok } from "./xrpc";
import {
  awaitFirehose,
  emitCommit,
  eventually,
  HAPPYVIEW_URL,
  PDS_URL,
  stack,
  type Account,
} from "./setup";

const PROJECT = "software.release.project";
const MANIFEST = "software.release.manifest";
const VERSION = "software.release.version";
const CHANNEL = "software.release.channel";
const STATUS = "software.release.status";
const SIDECAR = "at.happyproto.registry.project";
const PUBLICATION = "site.standard.publication";
const DOCUMENT = "site.standard.document";
const REGISTRY = "at.happyproto.registry";

// Unique per run, so the suite can run again against a stack it already
// published to: every record key below derives from it.
const NAME = `demo-${Date.now().toString(36)}`;
const DISPLAY_NAME = "Integration Demo";
const CHANGELOG = "## 1.0.0\n\n- the first release";

/** Not a runnable module: nothing here executes it, the registry only copies it. */
const MODULE = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
const PLUGIN_MANIFEST = new TextEncoder().encode(JSON.stringify({ id: NAME, version: "1.0.0" }));

type BlobRef = { $type: "blob"; ref: { $link: string }; mimeType: string; size: number };
type Ref = { uri: string; cid: string };

// ---------------------------------------------------------------------------
// Records and their CIDs
// ---------------------------------------------------------------------------

/**
 * A record's JSON as the IPLD data model: `{$link}` is a CID and `{$bytes}`
 * bytes, as atproto's JSON encoding defines them.
 */
function toIpld(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toIpld);
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    const keys = Object.keys(object);
    if (keys.length === 1 && typeof object.$link === "string") return CID.parse(object.$link);
    if (keys.length === 1 && typeof object.$bytes === "string") {
      return new Uint8Array(Buffer.from(object.$bytes, "base64"));
    }
    return Object.fromEntries(keys.map((key) => [key, toIpld(object[key])]));
  }
  return value;
}

/** The CID of a record: CIDv1, dag-cbor, sha2-256, as a repo commits it. */
async function recordCid(record: unknown): Promise<string> {
  const bytes = dagCbor.encode(toIpld(record));
  return CID.createV1(dagCbor.code, await sha256.digest(bytes)).toString();
}

async function uploadBlob(account: Account, bytes: Uint8Array, mimeType: string): Promise<BlobRef> {
  const response = await fetch(`${PDS_URL}/xrpc/com.atproto.repo.uploadBlob`, {
    method: "POST",
    headers: { authorization: `Bearer ${account.accessJwt}`, "content-type": mimeType },
    body: bytes,
  });
  if (!response.ok) throw new Error(`uploadBlob: ${response.status} ${await response.text()}`);
  const { blob } = (await response.json()) as { blob: BlobRef };
  return blob;
}

const rkeyOf = (uri: string) => uri.split("/").pop()!;

/**
 * Write a record to the publisher's repo, as the gateway would, and deliver
 * the commit through the firehose, as the network would. The PDS holds no
 * lexicon for these, and `validate: false` says so rather than leaving it to
 * guess.
 */
async function publish(
  account: Account,
  collection: string,
  record: Record<string, unknown>,
  rkey?: string,
): Promise<Ref> {
  const body = { $type: collection, ...record };
  const response = await fetch(`${PDS_URL}/xrpc/com.atproto.repo.createRecord`, {
    method: "POST",
    headers: { authorization: `Bearer ${account.accessJwt}`, "content-type": "application/json" },
    body: JSON.stringify({ repo: account.did, collection, rkey, record: body, validate: false }),
  });
  if (!response.ok) throw new Error(`createRecord ${collection}: ${response.status} ${await response.text()}`);
  const written = (await response.json()) as Ref;
  // The events that never pass through the PDS carry a CID computed the
  // same way, so this is what makes them believable.
  expect(await recordCid(body)).toBe(written.cid);
  await emitCommit({ did: account.did, collection, rkey: rkeyOf(written.uri), record: body, cid: written.cid });
  return { uri: written.uri, cid: written.cid };
}

/** Deliver a commit the PDS never saw, under its true CID. */
async function emitOnly(
  did: string,
  collection: string,
  rkey: string,
  record: Record<string, unknown>,
  operation: "create" | "update" = "create",
): Promise<Ref> {
  const body = { $type: collection, ...record };
  const cid = await recordCid(body);
  await emitCommit({ did, collection, rkey, record: body, cid, operation });
  return { uri: `at://${did}/${collection}/${rkey}`, cid };
}

/** A record key in TID form, for a record the PDS never assigned one. */
function tid(): string {
  const alphabet = "234567abcdefghijklmnopqrstuvwxyz";
  let n = (BigInt(Date.now()) * 1000n) << 10n;
  n |= BigInt(Math.floor(Math.random() * 1024));
  let out = "";
  for (let i = 0; i < 13; i++) {
    out = alphabet[Number(n & 31n)] + out;
    n >>= 5n;
  }
  return out;
}

// ---------------------------------------------------------------------------
// A PNG, so the images are what they claim to be
// ---------------------------------------------------------------------------

function crc32(bytes: Uint8Array): number {
  let crc = ~0;
  for (const byte of bytes) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  Buffer.from(data).copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** A one-pixel PNG of the given colour. */
function png([r, g, b]: [number, number, number]): Uint8Array {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // truecolour
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", header),
      chunk("IDAT", deflateSync(Buffer.from([0, r, g, b]))),
      chunk("IEND", new Uint8Array()),
    ]),
  );
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** A read that may not have caught up yet: an output or an error body. */
async function read(method: string, params: Record<string, string>): Promise<any> {
  return (await call(`${REGISTRY}.${method}`, null, { params })).body;
}

/** getArtifact by CID, which answers bytes rather than JSON. */
async function artifactBytes(query: string): Promise<{ status: number; type: string; bytes: Uint8Array }> {
  const response = await fetch(`${HAPPYVIEW_URL}/xrpc/${REGISTRY}.getArtifact?${query}`);
  return {
    status: response.status,
    type: response.headers.get("content-type") ?? "",
    bytes: new Uint8Array(await response.arrayBuffer()),
  };
}

const urisOf = (projects: { uri: string }[]) => projects.map((p) => p.uri);

/** Long enough for an event the indexer will skip to have been handled. */
const SETTLE_MS = 4000;

// ---------------------------------------------------------------------------

describe("the registry indexes a software.release plugin end to end", () => {
  let publisher: Account;
  let stranger: Account;
  let did: string;

  let packageBlob: BlobRef;
  let manifestBlob: BlobRef;
  let bannerBlob: BlobRef;
  let iconBlob: BlobRef;

  let publication: Ref;
  let artifact: Record<string, unknown>;
  let manifest: Ref;
  let manifestRecord: Record<string, unknown>;
  let version: Ref;
  let versionRecord: Record<string, unknown>;
  let document: Ref;

  const projectUri = () => `at://${did}/${PROJECT}/${NAME}`;
  const versionParams = (v = "1.0.0") => ({ did, name: NAME, version: v });

  beforeAll(async () => {
    const live = await stack();
    // The registry's own account publishes, as HappyProto's first-party
    // plugins are, so a state row and the record it describes share a DID.
    publisher = live.accounts.happyproto;
    stranger = live.accounts.customer;
    did = publisher.did;

    await awaitFirehose();

    packageBlob = await uploadBlob(publisher, MODULE, "application/wasm");
    manifestBlob = await uploadBlob(publisher, PLUGIN_MANIFEST, "application/json");
    bannerBlob = await uploadBlob(publisher, png([0x33, 0x66, 0x99]), "image/png");
    iconBlob = await uploadBlob(publisher, png([0xcc, 0x33, 0x66]), "image/png");

    publication = await publish(
      publisher,
      PUBLICATION,
      {
        name: DISPLAY_NAME,
        url: `https://happyproto.at/plugins/${did}/${NAME}`,
        description: "A plugin published by the integration suite.",
        icon: iconBlob,
      },
      NAME,
    );
  }, 60_000);

  test("a sidecar and its project are indexed, and the publication is cached", async () => {
    await publish(
      publisher,
      SIDECAR,
      {
        project: projectUri(),
        publication,
        pluginType: "library",
        keywords: ["integration"],
        authors: [{ name: "HappyProto", email: "integration@example.com" }],
        security: [{ email: "security@example.com" }],
      },
      NAME,
    );
    await publish(publisher, PROJECT, { name: NAME }, NAME);

    const view = await eventually(
      async () => {
        const body = await read("getProject", { actor: did, name: NAME });
        return body?.publication?.name === DISPLAY_NAME && body.cid ? body : null;
      },
      { label: "getProject to show the cached publication", timeoutMs: 60_000 },
    );
    expect(view).toMatchObject({
      uri: projectUri(),
      did,
      name: NAME,
      pluginType: "library",
      publication: { uri: publication.uri, cid: publication.cid, name: DISPLAY_NAME },
      lifecycle: { state: "active" },
    });
    // No channel yet, and an empty map must still encode as a JSON object:
    // the lexicon's `unknown` refuses an array.
    const validated = await ok(`${REGISTRY}.getProject`, null, { params: { actor: did, name: NAME } });
    expect(validated.channels).toEqual({});
  }, 90_000);

  test("the publication's icon is copied and verified against its CID", async () => {
    const icon = await eventually(
      async () => (await read("getProject", { actor: did, name: NAME }))?.publication?.icon,
      { label: "the publication icon to be copied", timeoutMs: 60_000 },
    );
    expect(icon).toBe(iconBlob.ref.$link);
    const served = await artifactBytes(`cid=${iconBlob.ref.$link}`);
    expect(served.status).toBe(200);
    expect(served.type).toContain("image/png");
  }, 90_000);

  test("a version becomes available once its blobs are copied over HTTP and verified", async () => {
    artifact = {
      $type: "at.happyproto.plugin.v1",
      package: packageBlob,
      manifest: manifestBlob,
      banner: { image: bannerBlob, width: 1200, height: 400, alt: "The demo's banner" },
      pluginType: "library",
      apiVersion: "2",
      capabilities: ["database:read"],
      namespace: "it.demo",
      license: "MIT",
      sections: { description: "A plugin that exists to be indexed." },
    };
    manifestRecord = { project: projectUri(), artifacts: [artifact] };
    manifest = await publish(publisher, MANIFEST, manifestRecord);

    document = await publish(publisher, DOCUMENT, {
      site: publication.uri,
      path: "/changelog/1.0.0",
      title: `${DISPLAY_NAME} 1.0.0`,
      publishedAt: new Date().toISOString(),
      textContent: CHANGELOG,
      content: {
        $type: "at.markpub.markdown",
        text: { $type: "at.markpub.text", markdown: CHANGELOG },
        flavor: "commonmark",
      },
    });

    versionRecord = { project: projectUri(), version: "1.0.0", manifest, changelog: document.uri };
    version = await publish(publisher, VERSION, versionRecord, `${NAME}.1.0.0`);
    await publish(publisher, CHANNEL, { project: projectUri(), channel: "latest", version }, `${NAME}.latest`);

    // The blob sizes and the banner's sides reach the indexer through the
    // host's JSON bridge, so there being a version at all says they passed
    // its integer checks.
    const view = await eventually(
      async () => {
        const body = await read("getVersion", versionParams());
        return body?.availability === "available" ? body : null;
      },
      { label: "getVersion to report the version available", timeoutMs: 90_000 },
    );
    expect(view).toMatchObject({
      uri: version.uri,
      cid: version.cid,
      did,
      name: NAME,
      version: "1.0.0",
      manifest,
      suspect: false,
      lifecycle: { state: "active", installable: true },
    });
    expect(view.artifact.package).toEqual(packageBlob);
    expect(view.artifact.banner).toMatchObject({ width: 1200, height: 400 });
    await ok(`${REGISTRY}.getVersion`, null, { params: versionParams() });
  }, 150_000);

  test("getArtifact serves the copied bytes by CID and by kind, and nothing else", async () => {
    const pkg = await artifactBytes(`cid=${packageBlob.ref.$link}`);
    expect(pkg.status).toBe(200);
    expect(pkg.type).toContain("application/wasm");
    expect([...pkg.bytes]).toEqual([...MODULE]);

    const manifestBytes = await artifactBytes(`cid=${manifestBlob.ref.$link}`);
    expect(manifestBytes.status).toBe(200);
    expect([...manifestBytes.bytes]).toEqual([...PLUGIN_MANIFEST]);

    const banner = await artifactBytes(`did=${did}&name=${NAME}&version=1.0.0&kind=banner`);
    expect(banner.status).toBe(200);
    expect(banner.type).toContain("image/png");

    // In the publisher's PDS, but held for no indexed version.
    const stray = await uploadBlob(publisher, png([1, 2, 3]), "image/png");
    await fails(`${REGISTRY}.getArtifact`, null, "ArtifactNotHeld", { params: { cid: stray.ref.$link } });
  });

  test("the changelog document is fetched from the PDS and served with the version", async () => {
    const view = await eventually(
      async () => {
        const body = await read("getVersion", versionParams());
        return body?.changelog ? body : null;
      },
      { label: "getVersion to carry the changelog", timeoutMs: 60_000 },
    );
    expect(view.changelog).toMatchObject({
      uri: document.uri,
      title: `${DISPLAY_NAME} 1.0.0`,
      markdown: CHANGELOG,
    });
    // With a cached changelog, getVersion reads the clock to decide whether
    // it is stale, so answering at all says os.time is in the sandbox.
    await ok(`${REGISTRY}.getVersion`, null, { params: versionParams() });
  }, 90_000);

  test("getProject, searchProjects, listVersions and resolveChannel answer the project", async () => {
    const project = await ok(`${REGISTRY}.getProject`, null, { params: { actor: did, name: NAME } });
    expect(project.channels.latest).toEqual({
      version: "1.0.0",
      uri: version.uri,
      cid: version.cid,
      state: "active",
      availability: "available",
    });
    expect(project.banner).toEqual({
      cid: bannerBlob.ref.$link,
      width: 1200,
      height: 400,
      alt: "The demo's banner",
    });

    // The display name is matched with ILIKE on a path inside the registry's
    // own state rows, the project name with ILIKE on the sidecar's `project`.
    const byDisplayName = await ok(`${REGISTRY}.searchProjects`, null, { params: { q: "INTEGRATION demo" } });
    expect(urisOf(byDisplayName.projects)).toContain(projectUri());
    const byName = await ok(`${REGISTRY}.searchProjects`, null, { params: { q: NAME.slice(0, -2) } });
    expect(urisOf(byName.projects)).toContain(projectUri());
    const byType = await ok(`${REGISTRY}.searchProjects`, null, { params: { pluginType: "library" } });
    expect(urisOf(byType.projects)).toContain(projectUri());
    const otherType = await ok(`${REGISTRY}.searchProjects`, null, { params: { pluginType: "auth" } });
    expect(urisOf(otherType.projects)).not.toContain(projectUri());

    const resolved = await ok(`${REGISTRY}.resolveChannel`, null, {
      params: { did, name: NAME, channel: "latest" },
    });
    expect(resolved).toMatchObject({ uri: version.uri, version: "1.0.0", availability: "available" });

    const versions = await ok(`${REGISTRY}.listVersions`, null, { params: { did, name: NAME } });
    expect(versions.versions.map((v: { version: string }) => v.version)).toEqual(["1.0.0"]);

    await fails(`${REGISTRY}.resolveChannel`, null, "ChannelNotFound", {
      params: { did, name: NAME, channel: "beta" },
    });
    await fails(`${REGISTRY}.getVersion`, null, "VersionNotFound", { params: versionParams("9.9.9") });
    await fails(`${REGISTRY}.getProject`, null, "ProjectNotFound", {
      params: { actor: did, name: "no-such-project" },
    });
  });

  test("an identical create delivered again is a replay, not a rewrite", async () => {
    // Read as a replay only if the stored row equals the event exactly; any
    // difference would be a rewrite and mark the version suspect.
    await emitCommit({
      did,
      collection: MANIFEST,
      rkey: rkeyOf(manifest.uri),
      record: { $type: MANIFEST, ...manifestRecord },
      cid: manifest.cid,
    });
    await emitCommit({
      did,
      collection: VERSION,
      rkey: `${NAME}.1.0.0`,
      record: { $type: VERSION, ...versionRecord },
      cid: version.cid,
    });
    await Bun.sleep(SETTLE_MS);
    const view = await ok(`${REGISTRY}.getVersion`, null, { params: versionParams() });
    expect(view).toMatchObject({ suspect: false, availability: "available" });
  }, 30_000);

  test("endOfDistribution makes the channel's version uninstallable, and withdrawing it restores it", async () => {
    const ended = await publish(publisher, STATUS, {
      subject: version.uri,
      status: "endOfDistribution",
      kind: "security",
      reason: "pulled while a fix is prepared",
    });
    const unavailable = await eventually(
      async () => {
        const body = await read("resolveChannel", { did, name: NAME, channel: "latest" });
        return body?.lifecycle?.state === "unavailable" ? body : null;
      },
      { label: "resolveChannel to report the version unavailable", timeoutMs: 30_000 },
    );
    expect(unavailable.lifecycle).toMatchObject({
      state: "unavailable",
      installable: false,
      kind: "security",
      reason: "pulled while a fix is prepared",
    });
    // Answered with its state, never passed over for some other version.
    expect(unavailable.version).toBe("1.0.0");
    const project = await ok(`${REGISTRY}.getProject`, null, { params: { actor: did, name: NAME } });
    expect(project.channels.latest.state).toBe("unavailable");

    await publish(publisher, STATUS, { subject: version.uri, status: "withdrawn", withdraws: ended.uri });
    const restored = await eventually(
      async () => {
        const body = await read("resolveChannel", { did, name: NAME, channel: "latest" });
        return body?.lifecycle?.state === "active" ? body : null;
      },
      { label: "resolveChannel to report the version active again", timeoutMs: 30_000 },
    );
    expect(restored.lifecycle.installable).toBe(true);
    const events = restored.lifecycle.events as { uri: string; withdrawnBy?: string }[];
    expect(events.find((e) => e.uri === ended.uri)?.withdrawnBy).toBeString();
    await ok(`${REGISTRY}.resolveChannel`, null, { params: { did, name: NAME, channel: "latest" } });
  }, 90_000);

  test("a status whose reason is longer than its lexicon allows is not indexed", async () => {
    // HappyView stores a record without checking it against its lexicon, so
    // the indexer holds the status lexicon's limits itself.
    const oversized = await emitOnly(did, STATUS, tid(), {
      subject: version.uri,
      status: "endOfSupport",
      reason: "x".repeat(3001),
    });
    await Bun.sleep(SETTLE_MS);
    const view = await ok(`${REGISTRY}.getVersion`, null, { params: versionParams() });
    expect(view.lifecycle.events.map((e: { uri: string }) => e.uri)).not.toContain(oversized.uri);
    expect(view.lifecycle.state).toBe("active");
  }, 30_000);

  test("a version the gateway mirrored is indexed when the network echoes it", async () => {
    // A gateway write lands in the index at once, with no indexed_at and
    // without the index script running. This puts a row there the same way,
    // through the compatibility view HappyView keeps writable for raw SQL,
    // and the echo of the identical record must still create the version's
    // state and start its copy.
    const record = { $type: VERSION, project: projectUri(), version: "1.1.0", manifest };
    const cid = await recordCid(record);
    const uri = `at://${did}/${VERSION}/${NAME}.1.1.0`;
    const db = new pg.Client(DB_URL);
    await db.connect();
    try {
      await db.query(
        `INSERT INTO happyview_records (uri, did, collection, rkey, record, cid, indexed_at, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, NULL, NULL)`,
        [uri, did, VERSION, `${NAME}.1.1.0`, JSON.stringify(record), cid],
      );
      // Mirrored only: no state, so nothing to serve yet.
      await fails(`${REGISTRY}.getVersion`, null, "VersionNotFound", { params: versionParams("1.1.0") });

      await emitCommit({ did, collection: VERSION, rkey: `${NAME}.1.1.0`, record, cid });
      const view = await eventually(
        async () => {
          const body = await read("getVersion", versionParams("1.1.0"));
          return body?.availability === "available" ? body : null;
        },
        { label: "the echoed version to be copied", timeoutMs: 60_000 },
      );
      expect(view).toMatchObject({ uri, cid, suspect: false, manifest });

      // And the echo stamped the row as the network's.
      const { rows } = await db.query("SELECT indexed_at FROM happyview_records WHERE uri = $1", [uri]);
      expect(rows[0]?.indexed_at).toBeTruthy();
    } finally {
      await db.end();
    }
  }, 90_000);

  test("a version of a project with no sidecar is never indexed", async () => {
    const strangerProject = `at://${stranger.did}/${PROJECT}/${NAME}`;
    await emitOnly(stranger.did, PROJECT, NAME, { name: NAME });
    const strangerManifest = await emitOnly(stranger.did, MANIFEST, tid(), {
      project: strangerProject,
      artifacts: [artifact],
    });
    await emitOnly(stranger.did, VERSION, `${NAME}.1.0.0`, {
      project: strangerProject,
      version: "1.0.0",
      manifest: strangerManifest,
    });
    await Bun.sleep(SETTLE_MS);
    await fails(`${REGISTRY}.getVersion`, null, "VersionNotFound", {
      params: { did: stranger.did, name: NAME, version: "1.0.0" },
    });
    await fails(`${REGISTRY}.getProject`, null, "ProjectNotFound", {
      params: { actor: stranger.did, name: NAME },
    });
  }, 30_000);

  describe("the gateway refuses what it would not write", () => {
    const artifactInput = (extra: Record<string, unknown> = {}) => ({
      package: packageBlob,
      manifest: manifestBlob,
      pluginType: "library",
      apiVersion: "2",
      capabilities: ["database:read"],
      namespace: "it.demo",
      license: "MIT",
      sections: { description: "A plugin that exists to be indexed." },
      ...extra,
    });
    const projectInput = () => ({
      name: NAME,
      publication: { name: DISPLAY_NAME },
      project: {
        pluginType: "library",
        authors: [{ name: "HappyProto" }],
        security: [{ email: "security@example.com" }],
      },
    });
    const release = (extra: Record<string, unknown> = {}) => ({
      name: NAME,
      version: "2.0.0",
      track: "latest",
      artifact: artifactInput(),
      validateOnly: true,
      ...extra,
    });

    // The procedures check their input before the caller, so that a
    // publisher could validate without signing in, but HappyView refuses a
    // procedure call with no session before any script runs. Validation is
    // exercised signed in, as `customer`, who publishes nothing.
    test("an anonymous call is refused before the script runs", async () => {
      const reply = await call(`${REGISTRY}.putProject`, null, {
        input: { ...projectInput(), validateOnly: true },
      });
      expect(reply.status).toBe(401);
    });

    test("valid input validates without writing", async () => {
      expect(
        await ok(`${REGISTRY}.putProject`, "customer", { input: { ...projectInput(), validateOnly: true } }),
      ).toEqual({ valid: true });
      expect(await ok(`${REGISTRY}.publishRelease`, "happyproto", { input: release() })).toEqual({ valid: true });
    });

    test("putProject refuses an invalid name and an invalid sidecar", async () => {
      await fails(`${REGISTRY}.putProject`, "customer", "InvalidRecord", {
        input: { ...projectInput(), name: "Not A Name", validateOnly: true },
      });
      const reply = await fails(`${REGISTRY}.putProject`, "customer", "InvalidRecord", {
        input: { ...projectInput(), project: { ...projectInput().project, security: [] }, validateOnly: true },
      });
      expect(reply.body.message).toContain("security");
    });

    test("publishRelease refuses a bad version, track or artifact", async () => {
      await fails(`${REGISTRY}.publishRelease`, "customer", "InvalidRecord", { input: release({ version: "v2" }) });
      await fails(`${REGISTRY}.publishRelease`, "customer", "InvalidRecord", { input: release({ track: "nightly" }) });
      const withUrl = await fails(`${REGISTRY}.publishRelease`, "customer", "InvalidRecord", {
        input: release({ artifact: artifactInput({ url: "https://example.com/m.wasm" }) }),
      });
      expect(withUrl.body.message).toContain("url");
      const tooBig = await fails(`${REGISTRY}.publishRelease`, "customer", "InvalidRecord", {
        input: release({ artifact: artifactInput({ package: { ...packageBlob, size: 16777217 } }) }),
      });
      expect(tooBig.body.message).toContain("package");
    });

    test("publishRelease checks the index for a signed-in publisher", async () => {
      // Another artifact under a published version.
      await fails(`${REGISTRY}.publishRelease`, "happyproto", "VersionExists", {
        input: release({ version: "1.0.0" }),
      });
      // The very artifact under it is a retry, resumed rather than refused.
      expect(
        await ok(`${REGISTRY}.publishRelease`, "happyproto", {
          input: release({ version: "1.0.0", artifact: artifactInput({ banner: artifact.banner }) }),
        }),
      ).toEqual({ valid: true });
      await fails(`${REGISTRY}.publishRelease`, "customer", "ProjectMissing", { input: release() });
      await fails(`${REGISTRY}.publishRelease`, "happyproto", "InvalidRecord", {
        input: release({ artifact: artifactInput({ pluginType: "auth" }) }),
      });
    });

    test("promoteRelease refuses bad input and versions it cannot promote", async () => {
      await fails(`${REGISTRY}.promoteRelease`, "customer", "InvalidRecord", {
        input: { name: NAME, fromVersion: "one", version: "2.0.0" },
      });
      await fails(`${REGISTRY}.promoteRelease`, "happyproto", "VersionNotFound", {
        input: { name: NAME, fromVersion: "9.9.9", version: "2.0.0" },
      });
      // 1.1.0 is already on 1.0.0's manifest: a retry, finished without a write.
      expect(
        await ok(`${REGISTRY}.promoteRelease`, "happyproto", {
          input: { name: NAME, fromVersion: "1.0.0", version: "1.1.0" },
        }),
      ).toEqual({ resumed: true, version: { uri: `at://${did}/${VERSION}/${NAME}.1.1.0`, cid: expect.any(String) } });

      // 0.9.0 is on another manifest, so promoting onto it would rewrite it.
      const otherManifest = await publish(publisher, MANIFEST, {
        project: projectUri(),
        artifacts: [{ ...artifact, license: "Apache-2.0" }],
      });
      await publish(
        publisher,
        VERSION,
        { project: projectUri(), version: "0.9.0", manifest: otherManifest },
        `${NAME}.0.9.0`,
      );
      await eventually(
        async () => (await read("getVersion", versionParams("0.9.0")))?.version === "0.9.0",
        { label: "0.9.0 to be indexed", timeoutMs: 30_000 },
      );
      await fails(`${REGISTRY}.promoteRelease`, "happyproto", "VersionExists", {
        input: { name: NAME, fromVersion: "1.0.0", version: "0.9.0" },
      });
      await fails(`${REGISTRY}.promoteRelease`, "customer", "ProjectMissing", {
        input: { name: NAME, fromVersion: "1.0.0", version: "2.0.0" },
      });
    }, 60_000);

    test("putStatus refuses an invalid status and a subject that is not the caller's", async () => {
      await fails(`${REGISTRY}.putStatus`, "customer", "InvalidStatus", {
        input: { subject: version.uri, status: "supersededBy" },
      });
      await fails(`${REGISTRY}.putStatus`, "customer", "InvalidStatus", {
        input: { subject: version.uri, status: "withdrawn" },
      });
      await fails(`${REGISTRY}.putStatus`, "customer", "InvalidRecord", {
        input: { subject: version.uri, status: "endOfSupport", reason: "x".repeat(3001) },
      });
      await fails(`${REGISTRY}.putStatus`, "customer", "SubjectNotFound", {
        input: { subject: version.uri, status: "endOfSupport" },
      });
    });

    test("retryVersion is the registry's own, and answers the availability", async () => {
      await fails(`${REGISTRY}.retryVersion`, "customer", "InvalidRecord", {
        input: { did: "not-a-did", name: NAME, version: "1.0.0" },
      });
      await fails(`${REGISTRY}.retryVersion`, "customer", "Forbidden", { input: versionParams() });
      await fails(`${REGISTRY}.retryVersion`, "happyproto", "VersionNotFound", {
        input: versionParams("9.9.9"),
      });
      expect(await ok(`${REGISTRY}.retryVersion`, "happyproto", { input: versionParams() })).toEqual({
        availability: "available",
      });
    });

    test("a retired project refuses a channel move, and is hidden from search", async () => {
      const retired = await publish(publisher, STATUS, { subject: projectUri(), status: "endOfLife" });
      await eventually(
        async () => (await read("getProject", { actor: did, name: NAME }))?.lifecycle?.state === "retired",
        { label: "getProject to report the project retired", timeoutMs: 30_000 },
      );
      await fails(`${REGISTRY}.publishRelease`, "happyproto", "NotInstallable", { input: release() });
      await fails(`${REGISTRY}.promoteRelease`, "happyproto", "NotInstallable", {
        input: { name: NAME, fromVersion: "1.0.0", version: "2.0.0", track: "latest" },
      });
      const hidden = await ok(`${REGISTRY}.searchProjects`, "customer", { params: { q: "integration demo" } });
      expect(urisOf(hidden.projects)).not.toContain(projectUri());
      const shown = await ok(`${REGISTRY}.searchProjects`, "customer", {
        params: { q: "integration demo", includeRetired: "true" },
      });
      expect(urisOf(shown.projects)).toContain(projectUri());

      await publish(publisher, STATUS, { subject: projectUri(), status: "withdrawn", withdraws: retired.uri });
      await eventually(
        async () => (await read("getProject", { actor: did, name: NAME }))?.lifecycle?.state === "active",
        { label: "getProject to report the project active again", timeoutMs: 30_000 },
      );
    }, 90_000);
  });

  // Last, because it leaves both versions suspect for good.
  test("an update of the manifest marks every version on it suspect", async () => {
    await emitOnly(
      did,
      MANIFEST,
      rkeyOf(manifest.uri),
      { ...manifestRecord, artifacts: [{ ...artifact, license: "Apache-2.0" }] },
      "update",
    );
    const view = await eventually(
      async () => {
        const body = await read("getVersion", versionParams());
        return body?.suspect === true ? body : null;
      },
      { label: "getVersion to report the version suspect", timeoutMs: 30_000 },
    );
    // The first manifest stays: what the version vouched for is still what
    // is served.
    expect(view.artifact.license).toBe("MIT");
    // Found through the registry's own state rows by their manifestUri, not
    // only the version an event named.
    const other = await ok(`${REGISTRY}.getVersion`, null, { params: versionParams("1.1.0") });
    expect(other.suspect).toBe(true);
  }, 60_000);
});
