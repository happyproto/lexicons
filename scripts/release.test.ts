/**
 * The `release` prelude block, executed. Each case generates a tiny script
 * that takes the block exactly as a real script would, calls one helper and
 * hands back what it answered.
 */
import { afterAll, describe, expect } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generated, it, run } from "./procedure";

const dir = await mkdtemp(join(tmpdir(), "release-test-"));
afterAll(() => rm(dir, { recursive: true, force: true }));

let serial = 0;

/** Runs `body` (the inside of handle) after the release prelude. */
async function lua(body: string): Promise<any> {
  const path = join(dir, `case${serial++}.lua`);
  await writeFile(path, `-- @prelude release\n\nfunction handle(input, ctx)\n${body}\nend\n`);
  // A nil answer leaves `out` out of the JSON altogether; read it as null.
  return run(await generated(path), "", "{}", "{}").out ?? null;
}

const DID = "did:plc:alice";
const CID = "bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy";

const blob = (mimeType: string, size: number) =>
  `{ ["$type"] = "blob", ref = { ["$link"] = "${CID}" }, mimeType = "${mimeType}", size = ${size} }`;

/** A valid interpreter artifact, with `extra` spliced in to override fields. */
const artifact = (extra = "") => `{
  ["$type"] = "at.happyproto.plugin.v1",
  package = ${blob("application/wasm", 1234)},
  manifest = ${blob("application/json", 456)},
  banner = { image = ${blob("image/png", 2000)}, width = 1200, height = 400, alt = "a banner" },
  screenshots = { { image = ${blob("image/webp", 3000)}, width = 1280, height = 720 } },
  pluginType = "interpreter",
  apiVersion = "2",
  capabilities = { "library:call" },
  languageId = "lua",
  fileExtensions = { "lua" },
  allowedHosts = { "example.com" },
  requires = {
    ["env:happyview"] = ">=3.0.0-alpha.24",
    ["at://did:plc:bob/software.release.project/happyview-db"] = "^1.0",
  },
  license = "MIT",
  sections = { description = "Runs Lua." },
  ${extra}
}`;

describe("name, version and channel grammar", () => {
  const sixtyFour = "a".repeat(64);

  for (const name of ["a", "happyview-lua", sixtyFour, "a1-b2"]) {
    it(`accepts the name ${name.slice(0, 20)}`, async () => {
      expect(await lua(`return is_project_name("${name}")`)).toBe(true);
    });
  }
  for (const name of ["-a", "a-", "A", "a.b", "a:b", "a".repeat(65), ""]) {
    it(`refuses the name "${name.slice(0, 20)}"`, async () => {
      expect(await lua(`return is_project_name("${name}")`)).toBe(false);
    });
  }
  it("refuses a non-string name", async () => {
    expect(await lua(`return is_project_name(12)`)).toBe(false);
  });

  for (const v of ["1.2.0", "1.2.0-alpha.3", "0.0.0", "10.20.30-rc-1.x"]) {
    it(`accepts the version ${v}`, async () => {
      expect(await lua(`return is_release_version("${v}")`)).toBe(true);
    });
  }
  for (const v of ["v1.2.0", "1.2", "1.2.0+b", "1.2.0-Alpha", "01.2.0", "1.2.0-", "1.2.0-a..b"]) {
    it(`refuses the version ${v}`, async () => {
      expect(await lua(`return is_release_version("${v}")`)).toBe(false);
    });
  }
  it("refuses a version longer than 64", async () => {
    expect(await lua(`return is_release_version("1.0.0-${"a".repeat(60)}")`)).toBe(false);
  });

  it("takes any name-shaped channel, not only the tracks", async () => {
    expect(await lua(`return { is_channel_name("latest"), is_channel_name("lts-2"), is_channel_name("Beta") }`))
      .toEqual([true, true, false]);
    expect(await lua(`return { TRACKS.latest, TRACKS.beta, TRACKS.alpha, TRACKS.lts or false }`))
      .toEqual([true, true, true, false]);
  });
});

describe("record keys and uris", () => {
  it("splits a key on its one colon", async () => {
    expect(await lua(`return { split_rkey("happyview-lua:1.2.0") }`)).toEqual(["happyview-lua", "1.2.0"]);
  });
  it("refuses a key without exactly one colon", async () => {
    expect(await lua(`return { split_rkey("a") == nil, split_rkey("a:b:c") == nil, split_rkey(":b") == nil, split_rkey("a:") == nil }`))
      .toEqual([true, true, true, true]);
  });
  it("builds and parses an at-uri", async () => {
    expect(await lua(`return uri_of("${DID}", PROJECT, "x")`)).toBe(`at://${DID}/software.release.project/x`);
    expect(await lua(`return { parse_uri("at://${DID}/software.release.version/x:1.0.0") }`))
      .toEqual([DID, "software.release.version", "x:1.0.0"]);
    expect(await lua(`return { parse_uri("at://handle.test/a.b/c") == nil, parse_uri("https://x/a/b") == nil }`))
      .toEqual([true, true]);
  });
});

describe("version_lt", () => {
  const order = ["1.0.0-alpha.2", "1.0.0-alpha.10", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0", "1.0.1", "1.10.0", "2.0.0"];
  for (let i = 0; i + 1 < order.length; i++) {
    it(`${order[i]} < ${order[i + 1]}`, async () => {
      expect(await lua(`return { version_lt("${order[i]}", "${order[i + 1]}"), version_lt("${order[i + 1]}", "${order[i]}") }`))
        .toEqual([true, false]);
    });
  }
  it("a version is not below itself", async () => {
    expect(await lua(`return version_lt("1.0.0-alpha.1", "1.0.0-alpha.1")`)).toBe(false);
  });
});

describe("range_problem", () => {
  it("accepts Cargo ranges", async () => {
    expect(await lua(`return { range_problem("^1.0") == nil, range_problem(">=1.2, <2") == nil, range_problem("*") == nil }`))
      .toEqual([true, true, true]);
  });
  it("refuses || by name", async () => {
    expect(await lua(`return range_problem("^1 || ^2")`)).toContain("||");
  });
});

describe("artifact_problem", () => {
  const problem = (extra: string) => lua(`return artifact_problem(${artifact(extra)})`);

  it("passes a valid interpreter", async () => {
    expect(await problem("")).toBeNull();
  });

  const refused: [string, string, RegExp][] = [
    ["a missing package", "package = false,", /package/],
    ["a package that is not wasm", `package = ${blob("application/octet-stream", 10)},`, /package/],
    ["a package over 16 MiB", `package = ${blob("application/wasm", 16777217)},`, /package/],
    ["a manifest over 1 MB", `manifest = ${blob("application/json", 1000001)},`, /manifest/],
    ["an svg banner", `banner = { image = ${blob("image/svg+xml", 10)}, width = 1, height = 1 },`, /banner/],
    ["a screenshot without a width", `screenshots = { { image = ${blob("image/png", 10)}, height = 1 } },`, /screenshot/],
    ["an alt over 3000 bytes", `banner = { image = ${blob("image/png", 10)}, width = 1, height = 1, alt = string.rep("é", 1501) },`, /alt/],
    ["a checksum", `checksum = "sha256:abc",`, /checksum/],
    ["a url anywhere", `banner = { image = ${blob("image/png", 10)}, width = 1, height = 1, url = "https://x" },`, /url/],
    ["a library without a namespace", `pluginType = "library",`, /namespace/],
    ["an interpreter with a json extension", `fileExtensions = { "lua", "json" },`, /json/],
    ["an interpreter with no extensions", `fileExtensions = {},`, /fileExtensions/],
    ["a repeated extension", `fileExtensions = { "lua", "lua" },`, /twice/],
    ["an interpreter without a languageId", `languageId = false,`, /languageId/],
    ["an unknown plugin type", `pluginType = "theme",`, /pluginType/],
    ["apiVersion 1", `apiVersion = "1",`, /apiVersion/],
    ["no capabilities", `capabilities = false,`, /capabilities/],
    ["no license", `license = false,`, /license/],
    ["no description", `sections = { installation = "x" },`, /description/],
    ["a description over 2000 graphemes", `sections = { description = string.rep("a", 2001) },`, /description/],
    ["an allowed host over 256", `allowedHosts = { string.rep("h", 257) },`, /allowedHosts/],
  ];
  for (const [what, extra, message] of refused) {
    it(`refuses ${what}`, async () => {
      expect(await problem(extra)).toMatch(message);
    });
  }

  it("counts an emoji with a skin-tone modifier as one character", async () => {
    // 300 graphemes, 600 code points, 2400 bytes: within both alt limits.
    expect(await problem(`banner = { image = ${blob("image/png", 10)}, width = 1, height = 1, alt = string.rep("\u{1F44D}\u{1F3FD}", 300) },`))
      .toBeNull();
    expect(await problem(`banner = { image = ${blob("image/png", 10)}, width = 1, height = 1, alt = string.rep("\u{1F44D}\u{1F3FD}", 301) },`))
      .toMatch(/alt/);
  });

  it("refuses 9 screenshots", async () => {
    const shot = `{ image = ${blob("image/png", 10)}, width = 1, height = 1 }`;
    expect(await problem(`screenshots = { ${Array(9).fill(shot).join(", ")} },`)).toMatch(/screenshots/);
  });
  it("refuses a requires key with the old profile collection", async () => {
    expect(await problem(`requires = { ["at://${DID}/at.happyproto.plugin.profile/x"] = "^1" },`))
      .toMatch(/requires/);
  });
  it("refuses a || range in requires", async () => {
    expect(await problem(`requires = { ["env:happyview"] = "^2 || ^3" },`)).toMatch(/\|\|/);
  });
  it("passes a library with a namespace and no interpreter fields", async () => {
    expect(await problem(`pluginType = "library", namespace = "db", languageId = false, fileExtensions = false,`))
      .toBeNull();
  });
});

describe("sidecar_problem", () => {
  const sidecar = (project: string) => `{
    project = "${project}",
    publication = { uri = "at://${DID}/site.standard.publication/x", cid = "${CID}" },
    pluginType = "library",
    keywords = { "db" },
    authors = { { name = "Trezy" } },
    security = { { email = "sec@example.com" } },
  }`;

  it("passes a matching sidecar", async () => {
    expect(await lua(`return sidecar_problem(${sidecar(`at://${DID}/software.release.project/x`)}, "${DID}", "x")`))
      .toBeNull();
  });
  it("refuses a mismatched project uri", async () => {
    expect(await lua(`return sidecar_problem(${sidecar(`at://${DID}/software.release.project/y`)}, "${DID}", "x")`))
      .toMatch(/project/);
  });
  it("refuses a security contact with neither url nor email", async () => {
    expect(await lua(`local r = ${sidecar(`at://${DID}/software.release.project/x`)}
      r.security = { {} }
      return sidecar_problem(r, "${DID}", "x")`)).toMatch(/security/);
  });
});

describe("manifest_artifact", () => {
  it("answers the one plugin artifact", async () => {
    expect(await lua(`local a = manifest_artifact({ artifacts = { { ["$type"] = "x.y" }, ${artifact()} } })
      return a.languageId`)).toBe("lua");
  });
  it("refuses none or two", async () => {
    expect(await lua(`local _, p = manifest_artifact({ artifacts = { { ["$type"] = "x.y" } } }) return p`))
      .toMatch(/at\.happyproto\.plugin\.v1/);
    expect(await lua(`local _, p = manifest_artifact({ artifacts = { ${artifact()}, ${artifact()} } }) return p`))
      .toMatch(/at\.happyproto\.plugin\.v1/);
  });
});

describe("lifecycle", () => {
  const status = (tid: string, fields: string) =>
    `{ uri = "at://${DID}/software.release.status/${tid}", record = { subject = "s", ${fields} } }`;
  const lifecycle = (statuses: string[], project: string[] = []) =>
    lua(`return lifecycle({ ${statuses.join(", ")} }, { ${project.join(", ")} })`);

  it("is active with no events", async () => {
    const l = await lifecycle([]);
    expect(l.state).toBe("active");
    expect(l.installable).toBe(true);
  });
  it("is deprecated and installable after endOfSupport", async () => {
    const l = await lifecycle([status("3aaa", `status = "endOfSupport", reason = "old", kind = "security"`)]);
    expect(l).toMatchObject({ state: "deprecated", installable: true, reason: "old", kind: "security" });
    expect(l.events).toHaveLength(1);
  });
  it("is active again once endOfDistribution is withdrawn", async () => {
    const l = await lifecycle([
      status("3aab", `status = "withdrawn", withdraws = "at://${DID}/software.release.status/3aaa"`),
      status("3aaa", `status = "endOfDistribution"`),
    ]);
    expect(l.state).toBe("active");
    expect(l.events.map((e: any) => e.status)).toEqual(["endOfDistribution", "withdrawn"]);
    expect(l.events[0].withdrawnBy).toBe(`at://${DID}/software.release.status/3aab`);
  });
  it("takes the last event in rkey order", async () => {
    const l = await lifecycle([
      status("3aac", `status = "endOfSupport"`),
      status("3aaa", `status = "endOfLife"`),
    ]);
    expect(l.state).toBe("deprecated");
  });
  it("is unavailable after endOfDistribution", async () => {
    const l = await lifecycle([status("3aaa", `status = "endOfDistribution"`)]);
    expect(l).toMatchObject({ state: "unavailable", installable: false });
  });
  it("ignores an unknown status", async () => {
    const l = await lifecycle([status("3aaa", `status = "endOfSupport"`), status("3aab", `status = "yanked"`)]);
    expect(l.state).toBe("deprecated");
  });
  it("is retired when the project reached endOfLife over a deprecated version", async () => {
    const l = await lifecycle(
      [status("3aaa", `status = "endOfSupport"`)],
      [status("3aab", `status = "endOfLife", reason = "gone"`)],
    );
    expect(l).toMatchObject({ state: "retired", installable: false, reason: "gone" });
  });
  it("keeps the version's own state when it is worse than the project's", async () => {
    const l = await lifecycle(
      [status("3aaa", `status = "endOfDistribution"`)],
      [status("3aab", `status = "endOfSupport"`)],
    );
    expect(l.state).toBe("unavailable");
  });
  it("carries the version a supersededBy names", async () => {
    const l = await lifecycle([status("3aaa", `status = "supersededBy", supersededBy = "1.3.0"`)]);
    expect(l).toMatchObject({ state: "deprecated", installable: true, supersededBy: "1.3.0" });
    expect(l.events[0].supersededBy).toBe("1.3.0");
  });
  it("orders severity and picks the worse", async () => {
    expect(await lua(`return { worse("active", "deprecated"), worse("retired", "unavailable"), worse("deprecated", "deprecated") }`))
      .toEqual(["deprecated", "retired", "deprecated"]);
  });
});
