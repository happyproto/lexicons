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
  for (const v of ["v1.2.0", "1.2", "1.2.0+b", "1.2.0-Alpha", "01.2.0", "1.2.0-", "1.2.0-a..b", "1.0.0-01", "1.0.0-alpha.00"]) {
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
  it("splits a key at its first dot", async () => {
    expect(await lua(`return { split_rkey("happyview-lua.1.2.0-alpha.4") }`)).toEqual(["happyview-lua", "1.2.0-alpha.4"]);
    expect(await lua(`return { split_rkey("happyview-lua.latest") }`)).toEqual(["happyview-lua", "latest"]);
  });
  it("refuses a key without a name and a rest around a dot", async () => {
    expect(await lua(`return { split_rkey("a") == nil, split_rkey(".b") == nil, split_rkey("a.") == nil, split_rkey("A.b") == nil }`))
      .toEqual([true, true, true, true]);
  });
  it("refuses a colon key from before the dot scheme", async () => {
    expect(await lua(`return { split_rkey("happyview-lua:1.0.0-alpha.4") == nil, split_rkey("a:b") == nil }`))
      .toEqual([true, true]);
  });
  it("builds a key from a name and a rest", async () => {
    expect(await lua(`return release_rkey("happyview-lua", "1.2.0")`)).toBe("happyview-lua.1.2.0");
  });
  it("builds and parses an at-uri", async () => {
    expect(await lua(`return uri_of("${DID}", PROJECT, "x")`)).toBe(`at://${DID}/software.release.project/x`);
    expect(await lua(`return { parse_uri("at://${DID}/software.release.version/x.1.0.0") }`))
      .toEqual([DID, "software.release.version", "x.1.0.0"]);
    expect(await lua(`return { parse_uri("at://handle.test/a.b/c") == nil, parse_uri("https://x/a/b") == nil }`))
      .toEqual([true, true]);
  });
  it("keys a version's state by publisher, name and version", async () => {
    expect(await lua(`return version_state_rkey("${DID}", "x", "1.0.0")`)).toBe(`${DID}:x:1.0.0`);
  });
});

describe("same_value", () => {
  it("compares nested tables by value", async () => {
    expect(await lua(`return same_value({ a = 1, b = { "x", { c = true } } }, { b = { "x", { c = true } }, a = 1 })`))
      .toBe(true);
  });
  it("notices a missing, extra or changed field at any depth", async () => {
    expect(await lua(`return {
      same_value({ a = 1 }, { a = 1, b = 2 }),
      same_value({ a = 1, b = 2 }, { a = 1 }),
      same_value({ a = { b = 1 } }, { a = { b = 2 } }),
      same_value({ "x", "y" }, { "x" }),
      same_value(1, "1"),
    }`)).toEqual([false, false, false, false, false]);
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

  const alt = (lua: string) => `banner = { image = ${blob("image/png", 10)}, width = 1, height = 1, alt = ${lua} },`;
  it("counts what follows a joiner when it is not an emoji", async () => {
    // 3000 bytes and 750 graphemes: a joiner fuses only emoji.
    expect(await problem(alt(`string.rep("\u{200D}a", 750)`))).toMatch(/alt/);
  });
  it("counts an unassigned code point in a combining block as its own grapheme", async () => {
    expect(await problem(alt(`string.rep("\u{20F1}", 1000)`))).toMatch(/alt/);
  });
  // Each is at most 3000 bytes, and more than 300 graphemes however a joiner
  // is read, so a counter that lets a joiner swallow them is caught here.
  for (const [label, unit] of [
    ["a, ZWJ, emoji", "a\\u{200D}\\u{1F600}"],
    ["a, ZWJ, sun", "a\\u{200D}\\u{2600}"],
    ["ZWJ, emoji", "\\u{200D}\\u{1F600}"],
    ["ZWJ, ZWJ, emoji", "\\u{200D}\\u{200D}\\u{1F600}"],
    ["ZWJ, VS16, sun", "\\u{200D}\\u{FE0F}\\u{2600}"],
  ]) {
    it(`refuses 300 of ${label} as an alt`, async () => {
      expect(await lua(`return #string.rep("${unit}", 300) <= 3000`)).toBe(true);
      expect(await problem(alt(`string.rep("${unit}", 300)`))).toMatch(/alt is longer than 300 characters/);
    });
  }
  it("counts emoji, ZWJ, a as two", async () => {
    expect(await lua(`return graphemes(string.rep("\\u{1F600}\\u{200D}a", 300))`)).toBe(600);
  });
  it("counts a family as one", async () => {
    expect(await lua(`return {
      graphemes("\\u{1F468}\\u{200D}\\u{1F469}\\u{200D}\\u{1F467}\\u{200D}\\u{1F466}"),
      graphemes("\\u{1F469}\\u{200D}\\u{2764}\\u{FE0F}\\u{200D}\\u{1F48B}\\u{200D}\\u{1F468}"),
      graphemes("\\u{1F44D}\\u{1F3FD}"),
    }`)).toEqual([1, 1, 1]);
  });
  it("does not join a chain longer than any real emoji sequence", async () => {
    expect(await lua(`return graphemes(string.rep("\\u{1F600}\\u{200D}", 8) .. "\\u{1F600}")`)).toBeGreaterThan(1);
  });

  it("still fuses an emoji joined to an emoji", async () => {
    // Family: man, ZWJ, woman, ZWJ, girl. One grapheme, 18 bytes, 166 of them.
    expect(await problem(alt(`string.rep("\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}", 166)`))).toBeNull();
  });

  it("takes integral floats for sizes and dimensions", async () => {
    expect(await problem(`package = ${blob("application/wasm", 1234)}, banner = { image = ${blob("image/png", 2000)}, width = 1200.0, height = 400.0 },`))
      .toBeNull();
    expect(await lua(`local a = ${artifact()} a.package.size = 1234.0 return artifact_problem(a)`)).toBeNull();
  });
  it("refuses a size or dimension that is not finite", async () => {
    expect(await lua(`local a = ${artifact()} a.package.size = math.huge return artifact_problem(a)`)).toMatch(/package/);
    expect(await lua(`local a = ${artifact()} a.package.size = 0/0 return artifact_problem(a)`)).toMatch(/package/);
    expect(await lua(`local a = ${artifact()} a.banner.width = math.huge return artifact_problem(a)`)).toMatch(/banner\.width/);
  });
  it("refuses a fractional or negative size or dimension", async () => {
    expect(await lua(`local a = ${artifact()} a.package.size = 12.5 return artifact_problem(a)`)).toMatch(/package/);
    expect(await lua(`local a = ${artifact()} a.package.size = -1 return artifact_problem(a)`)).toMatch(/package/);
    expect(await lua(`local a = ${artifact()} a.banner.width = 1.5 return artifact_problem(a)`)).toMatch(/banner\.width/);
    expect(await lua(`local a = ${artifact()} a.banner.height = -400.0 return artifact_problem(a)`)).toMatch(/banner\.height/);
  });
  it("refuses a blob whose link is not a CID", async () => {
    expect(await lua(`local a = ${artifact()} a.package.ref["$link"] = "QmNotBase32" return artifact_problem(a)`))
      .toMatch(/package has no CID/);
    expect(await lua(`local a = ${artifact()} a.package.ref["$link"] = "b" .. string.rep("a", 128) return artifact_problem(a)`))
      .toMatch(/package has no CID/);
  });
  it("refuses a package given as a string", async () => {
    expect(await problem(`package = "${CID}",`)).toMatch(/package must be a blob/);
  });
  it("refuses a mimeType that is a table", async () => {
    expect(await lua(`local a = ${artifact()} a.manifest.mimeType = { "application/json" } return artifact_problem(a)`))
      .toMatch(/manifest has a type/);
  });
  it("refuses screenshots given as a map", async () => {
    expect(await problem(`screenshots = { first = { image = ${blob("image/png", 10)}, width = 1, height = 1 } },`))
      .toMatch(/screenshots must be a list/);
  });
  it("refuses a capability over 128 characters", async () => {
    expect(await problem(`capabilities = { string.rep("c", 129) },`)).toMatch(/capabilities\[1\]/);
  });
  it("refuses a section it does not know", async () => {
    expect(await problem(`sections = { description = "x", changelog = "y" },`)).toMatch(/sections\.changelog/);
  });
  it("refuses an env key that is not a project-shaped name", async () => {
    expect(await problem(`requires = { ["env:HappyView"] = "^3" },`)).toMatch(/requires key/);
    expect(await problem(`requires = { ["env:"] = "^3" },`)).toMatch(/requires key/);
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
  const valid = sidecar(`at://${DID}/software.release.project/x`);
  const edit = (change: string) => lua(`local r = ${valid}\n${change}\nreturn sidecar_problem(r, "${DID}", "x")`);
  it("refuses more than 20 keywords", async () => {
    expect(await edit(`r.keywords = {} for i = 1, 21 do r.keywords[i] = "k" .. i end`)).toMatch(/keywords/);
  });
  it("refuses a keyword over 32 graphemes", async () => {
    expect(await edit(`r.keywords = { string.rep("k", 33) }`)).toMatch(/keywords\[1\]/);
  });
  it("refuses an author name over 128 graphemes, or none", async () => {
    expect(await edit(`r.authors = { { name = string.rep("n", 129) } }`)).toMatch(/authors\[1\]\.name/);
    expect(await edit(`r.authors = { { url = "https://x" } }`)).toMatch(/authors\[1\]\.name/);
    expect(await edit(`r.authors = {}`)).toMatch(/authors/);
  });
  it("refuses an author or contact url that is not a web link", async () => {
    expect(await edit(`r.authors = { { name = "T", url = "javascript:alert(1)" } }`)).toMatch(/authors\[1\]\.url/);
    expect(await edit(`r.security = { { url = "ftp://x" } }`)).toMatch(/security\[1\]\.url/);
    expect(await edit(`r.security = { { url = "https://" } }`)).toMatch(/security\[1\]\.url/);
    expect(await edit(`r.security = { { url = "https:///path" } }`)).toMatch(/security\[1\]\.url/);
    expect(await edit(`r.security = { { url = "https:// x" } }`)).toMatch(/security\[1\]\.url/);
    expect(await edit(`r.authors = { { name = "T", url = "http://x" } } r.security = { { url = "https://x/sec" } }`)).toBeNull();
  });
  it("refuses a link with no host right after the scheme, or with user info", async () => {
    for (const url of ["https://?q", "https://#a", "https://:80", "https://user@example.com", "https://-x", "https://x:123456", "https://x\\ty"]) {
      expect(await edit(`r.security = { { url = "${url}" } }`)).toMatch(/security\[1\]\.url/);
    }
    for (const url of ["http://localhost:2583", "https://[::1]:8080/x", "https://x?q", "https://x#a", "https://a.b-c.example/p?q=1"]) {
      expect(await edit(`r.security = { { url = "${url}" } }`)).toBeNull();
    }
  });
  it("refuses an author or contact url over 2048 bytes", async () => {
    const at = (n: number) => `"https://x/" .. string.rep("a", ${n} - 10)`;
    expect(await edit(`r.authors = { { name = "T", url = ${at(2048)} } }`)).toBeNull();
    expect(await edit(`r.authors = { { name = "T", url = ${at(2049)} } }`)).toMatch(/authors\[1\]\.url is longer than 2048/);
    expect(await edit(`r.security = { { url = ${at(2049)} } }`)).toMatch(/security\[1\]\.url is longer than 2048/);
  });
  it("refuses more than 20 authors or 20 security contacts", async () => {
    expect(await edit(`r.authors = {} for i = 1, 20 do r.authors[i] = { name = "a" .. i } end`)).toBeNull();
    expect(await edit(`r.authors = {} for i = 1, 21 do r.authors[i] = { name = "a" .. i } end`)).toMatch(/authors lists more than 20/);
    expect(await edit(`r.security = {} for i = 1, 20 do r.security[i] = { email = "s" .. i } end`)).toBeNull();
    expect(await edit(`r.security = {} for i = 1, 21 do r.security[i] = { email = "s" .. i } end`)).toMatch(/security lists more than 20/);
  });
  it("refuses a publication cid that is not shaped like a CID", async () => {
    for (const cid of [`"x"`, `"bafy-not-a-cid"`, `"BAFYREI"`, `"b" .. string.rep("a", 128)`, `""`, `7`]) {
      expect(await edit(`r.publication.cid = ${cid}`)).toMatch(/publication\.cid/);
    }
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
  it("takes the version's reason when it ties the project's state", async () => {
    const l = await lifecycle(
      [status("3aaa", `status = "endOfSupport", reason = "mine", kind = "broken"`)],
      [status("3aab", `status = "endOfDevelopment", reason = "project's", kind = "security"`)],
    );
    expect(l).toMatchObject({ state: "deprecated", reason: "mine", kind: "broken" });
  });
  it("does not reinstate a status when its withdrawal is itself withdrawn", async () => {
    // A withdrawal is final: withdrawing it marks it withdrawn but does not
    // bring back what it cancelled. Publish the status again instead.
    const l = await lifecycle([
      status("3aaa", `status = "endOfDistribution"`),
      status("3aab", `status = "withdrawn", withdraws = "at://${DID}/software.release.status/3aaa"`),
      status("3aac", `status = "withdrawn", withdraws = "at://${DID}/software.release.status/3aab"`),
    ]);
    expect(l.state).toBe("active");
    expect(l.events.map((e: any) => e.withdrawnBy ?? null)).toEqual([
      `at://${DID}/software.release.status/3aab`,
      `at://${DID}/software.release.status/3aac`,
      null,
    ]);
  });
  it("drops event fields that are not strings", async () => {
    const l = await lifecycle([status("3aaa", `status = "supersededBy", supersededBy = { "1.3.0" }, reason = 7, kind = true`)]);
    expect(l.state).toBe("deprecated");
    expect(l.supersededBy).toBeUndefined();
    expect(l.reason).toBeUndefined();
    expect(l.kind).toBeUndefined();
    expect(l.events[0]).toEqual({ uri: `at://${DID}/software.release.status/3aaa`, status: "supersededBy" });
  });

  it("orders severity and picks the worse", async () => {
    expect(await lua(`return { worse("active", "deprecated"), worse("retired", "unavailable"), worse("deprecated", "deprecated") }`))
      .toEqual(["deprecated", "retired", "deprecated"]);
  });
});

describe("canonical_json", () => {
  it("orders every object's keys, whatever order the map was built in", async () => {
    expect(await lua(`return canonical_json({ b = 1, a = { d = true, c = "x" } })`)).toBe(
      `{"a":{"c":"x","d":true},"b":1}`,
    );
  });
  it("keeps a list in its own order", async () => {
    expect(await lua(`return canonical_json({ "b", "a", { z = 1, y = 2 } })`)).toBe(`["b","a",{"y":2,"z":1}]`);
  });
  it("encodes an integral float as the integer it is", async () => {
    expect(await lua(`return canonical_json({ size = 456.0 }) == canonical_json({ size = 456 })`)).toBe(true);
    expect(await lua(`return canonical_json(1.5)`)).toBe("1.5");
  });
  it("tells two artifacts apart by any field", async () => {
    expect(await lua(`return canonical_json({ license = "MIT" }) == canonical_json({ license = "Apache-2.0" })`)).toBe(false);
  });
});
