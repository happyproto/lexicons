/**
 * The registry, end to end: a profile and a release reach the indexers through
 * the firehose, the artifact is copied out of the publisher's PDS, and the
 * five query endpoints answer from the index.
 *
 * This is the only test that exercises the indexers, the copy job, and the
 * success paths at all. The read-only refusals are cheap to check against a
 * deployed instance; nothing else here is.
 *
 * Everything stays inside the stack: the artifact is a blob in the publisher's
 * own PDS, which `atproto.blob_download` reaches by resolving the DID through
 * the stack's PLC.
 */

import { beforeAll, describe, expect, test } from "bun:test";

import { call, fails } from "./xrpc";
import {
  awaitFirehose,
  emitCommit,
  eventually,
  HAPPYVIEW_URL,
  PDS_URL,
  stack,
  type Account,
  type Stack,
} from "./setup";

const PROFILE = "at.happyproto.plugin.profile";
const RELEASE = "at.happyproto.plugin.release";
const SLUG = "integration-demo";

/** The module bytes. Not a real WASM module -- nothing here executes it. */
const MODULE = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

type BlobRef = {
  $type: "blob";
  ref: { $link: string };
  mimeType: string;
  size: number;
};

/** Upload the module into the publisher's own repo, as them. */
async function uploadModule(publisher: Account): Promise<BlobRef> {
  const response = await fetch(`${PDS_URL}/xrpc/com.atproto.repo.uploadBlob`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${publisher.accessJwt}`,
      "content-type": "application/wasm",
    },
    body: MODULE,
  });
  if (!response.ok) {
    throw new Error(`uploadBlob: ${response.status} ${await response.text()}`);
  }
  const { blob } = (await response.json()) as { blob: BlobRef };
  return blob;
}

async function query(method: string, params: Record<string, string>) {
  const url = new URL(`${HAPPYVIEW_URL}/xrpc/at.happyproto.registry.${method}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const response = await fetch(url);
  return {
    status: response.status,
    contentType: response.headers.get("content-type") ?? "",
    body: response,
  };
}

async function json(method: string, params: Record<string, string>) {
  const { status, body } = await query(method, params);
  return { status, json: (await body.json()) as Record<string, unknown> };
}

describe("the registry indexes a published package", () => {
  let publisher: Account;
  let blob: BlobRef;

  beforeAll(async () => {
    const live: Stack = await stack();
    publisher = live.accounts.customer;

    // The subscription has to be up before anything is emitted: an event with
    // no subscriber is delivered to nobody and would fail far from here.
    await awaitFirehose();
    blob = await uploadModule(publisher);

    await emitCommit({
      did: publisher.did,
      collection: PROFILE,
      rkey: SLUG,
      record: {
        $type: PROFILE,
        type: "happyview-plugin",
        name: "Integration Demo",
        description: "A package published by the integration suite.",
        license: "MIT",
        authors: ["HappyProto <integration@example.com>"],
        security: ["mailto:integration@example.com"],
        keywords: ["integration"],
      },
    });

    await emitCommit({
      did: publisher.did,
      collection: RELEASE,
      rkey: `${SLUG}:1.0.0`,
      record: {
        $type: RELEASE,
        package: SLUG,
        version: "1.0.0",
        artifacts: {
          // A `url` rather than the `blob`, which the copy job would otherwise
          // prefer. The bytes and the checksum are the same either way -- this
          // is the publisher's own blob -- but `atproto.blob_download`
          // resolves the DID and gets `https://pds.localhost` out of the DID
          // document, which no container can reach and which this stack
          // terminates no TLS for. Fetching the same blob over the in-network
          // http address covers the copy job, the checksum check and the
          // store; it leaves `blob_download` itself uncovered.
          package: {
            url: `http://pds:3000/xrpc/com.atproto.sync.getBlob?did=${publisher.did}&cid=${blob.ref.$link}`,
            // A CID carries the same sha2-256 multihash a bare checksum names,
            // so the copy job finds the digest in either.
            checksum: blob.ref.$link,
            contentType: "application/wasm",
          },
        },
        extensions: {
          "at.happyproto.plugin.releaseExtension": {
            pluginType: "library",
            apiVersion: "2",
            capabilities: ["database:read"],
            namespace: "happyview.demo",
          },
        },
      },
    });
  });

  test("getPackage answers the indexed profile", async () => {
    const found = await eventually(
      async () => {
        const { status, json: body } = await json("getPackage", {
          actor: publisher.did,
          slug: SLUG,
        });
        // The profile indexes first and answers 200 on its own. `latestVersion`
        // arrives only once the copy job has marked a release active, so
        // waiting on the status alone reads the package too early.
        return status === 200 && body.latestVersion ? body : null;
      },
      { label: "getPackage to find the package", timeoutMs: 60_000 },
    );

    // `package_view` answers unwrapped, and the record's own fields sit under
    // `record` rather than being flattened onto it.
    expect(found).toMatchObject({
      did: publisher.did,
      uri: `at://${publisher.did}/${PROFILE}/${SLUG}`,
      latestVersion: "1.0.0",
    });
    expect(found.record).toMatchObject({ name: "Integration Demo", license: "MIT" });
  }, 90_000);

  test("listReleases and getRelease answer the indexed release", async () => {
    const listed = await eventually(
      async () => {
        const { json: body } = await json("listReleases", { did: publisher.did, slug: SLUG });
        const releases = body.releases as unknown[] | undefined;
        return releases?.length ? body : null;
      },
      { label: "listReleases to report the release", timeoutMs: 60_000 },
    );
    const releases = listed.releases as { record: { version: string } }[];
    expect(releases[0]?.record.version).toBe("1.0.0");

    const { status, json: one } = await json("getRelease", {
      did: publisher.did,
      slug: SLUG,
      version: "1.0.0",
    });
    expect(status).toBe(200);
    expect(one.uri).toBe(`at://${publisher.did}/${RELEASE}/${SLUG}:1.0.0`);
    expect(one.record).toMatchObject({ version: "1.0.0", package: SLUG });
  }, 90_000);

  test("searchPackages finds it by name", async () => {
    const found = await eventually(
      async () => {
        // `db.search` is over the profile's `name`; the slug is the record
        // key and is not what this searches. One word, because a space is
        // form-urlencoded to `+` by `URLSearchParams` and instances before
        // 3.0.0-alpha.8 read that as a literal plus; the decoding itself is
        // pinned by HappyView's own `parse_query_params` tests.
        const { json: body } = await json("searchPackages", { q: "Integration" });
        const packages = body.packages as { uri: string }[] | undefined;
        return packages?.some((p) => p.uri.endsWith(`/${PROFILE}/${SLUG}`)) ? body : null;
      },
      { label: "searchPackages to return the package", timeoutMs: 60_000 },
    );
    expect(found.packages).toBeArray();
  }, 90_000);

  test("getArtifact serves the copied module bytes", async () => {
    // The copy job runs after indexing, so the artifact appears later than the
    // release does.
    const served = await eventually(
      async () => {
        const { status, contentType, body } = await query("getArtifact", {
          did: publisher.did,
          slug: SLUG,
          version: "1.0.0",
        });
        if (status !== 200) return null;
        return { contentType, bytes: new Uint8Array(await body.arrayBuffer()) };
      },
      { label: "getArtifact to serve the module", timeoutMs: 60_000 },
    );

    expect(served.contentType).toContain("application/wasm");
    expect([...served.bytes]).toEqual([...MODULE]);
  }, 120_000);

  test("a version that was never published is still ReleaseNotFound at 400", async () => {
    const { status, json: body } = await json("getRelease", {
      did: publisher.did,
      slug: SLUG,
      version: "9.9.9",
    });
    expect(status).toBe(400);
    expect(body.error).toBe("ReleaseNotFound");
  });
});

/** A profile body the rules accept. */
function validProfile(): Record<string, unknown> {
  return {
    $type: PROFILE,
    type: "happyview-plugin",
    name: "Probe",
    license: "MIT",
    authors: ["HappyProto <integration@example.com>"],
    security: ["mailto:integration@example.com"],
  };
}

describe("the publish procedures answer what the indexer would do", () => {
  let publisher: Account;

  beforeAll(async () => {
    publisher = (await stack()).accounts.customer;
  });

  test("a valid profile validates without writing", async () => {
    const reply = await call("at.happyproto.registry.publishProfile", "customer", {
      input: { slug: "probe-dry-run", record: validProfile(), validateOnly: true },
    });
    expect(reply.status).toBe(200);
    expect(reply.body).toMatchObject({ valid: true });
    // validateOnly writes nothing, so there is no record to point at.
    expect(reply.body.uri).toBeUndefined();
  });

  test("a profile naming another ecosystem is refused by name", async () => {
    const reply = await fails(
      "at.happyproto.registry.publishProfile",
      "customer",
      "InvalidRecord",
      { input: { slug: "probe-wrong-type", record: { ...validProfile(), type: "npm" }, validateOnly: true } },
    );
    expect(reply.body.message).toContain("happyview-plugin");
  });

  test("a slug that is not a slug is refused", async () => {
    await fails("at.happyproto.registry.publishProfile", "customer", "InvalidRecord", {
      input: { slug: "Not A Slug", record: validProfile(), validateOnly: true },
    });
  });

  // The release the firehose published in the suite above is indexed, so this
  // is the real immutability check rather than a contrived one.
  test("republishing a published version is refused as VersionExists", async () => {
    const reply = await fails(
      "at.happyproto.registry.publishRelease",
      "customer",
      "VersionExists",
      {
        input: {
          record: {
            $type: RELEASE,
            package: SLUG,
            version: "1.0.0",
            artifacts: { package: { url: "https://example.com/m.wasm", checksum: "bogus" } },
            extensions: {
              "at.happyproto.plugin.releaseExtension": {
                pluginType: "library",
                apiVersion: "2",
                capabilities: [],
                namespace: "happyview.demo",
              },
            },
          },
        },
      },
    );
    expect(reply.body.message).toContain("already published");
  });

  test("a release whose requires is not a range is refused by name", async () => {
    const reply = await fails(
      "at.happyproto.registry.publishRelease",
      "customer",
      "InvalidRecord",
      {
        input: {
          validateOnly: true,
          record: {
            $type: RELEASE,
            package: SLUG,
            version: "2.0.0",
            requires: { "env:happyview": "not a range" },
            artifacts: { package: { url: "https://example.com/m.wasm", checksum: "bogus" } },
            extensions: {
              "at.happyproto.plugin.releaseExtension": {
                pluginType: "library",
                apiVersion: "2",
                capabilities: [],
                namespace: "happyview.demo",
              },
            },
          },
        },
      },
    );
    expect(typeof reply.body.message).toBe("string");
  });

  test("a release for a slug with no indexed profile is refused", async () => {
    await fails("at.happyproto.registry.publishRelease", "customer", "ProfileMissing", {
      input: {
        validateOnly: true,
        record: {
          $type: RELEASE,
          package: "no-such-package",
          version: "1.0.0",
          artifacts: { package: { url: "https://example.com/m.wasm", checksum: "bogus" } },
          extensions: {
            "at.happyproto.plugin.releaseExtension": {
              pluginType: "library",
              apiVersion: "2",
              capabilities: [],
              namespace: "happyview.demo",
            },
          },
        },
      },
    });
  });
});
