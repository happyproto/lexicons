/**
 * Checks permission-set lexicons against https://atproto.com/specs/permission.
 *
 * @atproto/lexicon loads a permission set without looking inside it, and a PDS
 * ignores a permission it can't read instead of refusing the set. A mistake
 * here would publish cleanly and then grant nothing at sign-in, so it has to
 * be caught before publishing.
 */

type Json = Record<string, unknown>;

const ACTIONS = new Set(["create", "update", "delete"]);
const NSID = /^[a-zA-Z](?:[a-zA-Z0-9-]*\.)+[a-zA-Z][a-zA-Z0-9]*$/;

/** Every problem with the document's permission set; none when it has no set. */
export function permissionSetProblems(doc: Json): string[] {
  const defs = (doc.defs ?? {}) as Record<string, Json>;
  const problems: string[] = [];
  for (const [name, def] of Object.entries(defs)) {
    if (def?.type !== "permission-set") continue;
    if (name !== "main") {
      problems.push(`${name}: a permission set must be only the main def`);
      continue;
    }
    problems.push(...setProblems(String(doc.id), def));
  }
  return problems;
}

function setProblems(id: string, set: Json): string[] {
  const permissions = set.permissions;
  if (!Array.isArray(permissions) || permissions.length === 0) {
    return ["the set has no permissions"];
  }
  // A set may reach into its own NSID group and the groups below it, never a
  // sibling or parent: com.example.fullAccess covers com.example.*.
  const group = id.split(".").slice(0, -1).join(".");
  const problems: string[] = [];
  permissions.forEach((p: Json, i) => {
    const at = `permissions[${i}]`;
    if (p?.type !== "permission") {
      problems.push(`${at}: type must be "permission"`);
      return;
    }
    switch (p.resource) {
      case "repo":
        problems.push(...nsids(at, "collection", p.collection, group));
        if (p.action !== undefined) {
          const actions = Array.isArray(p.action) ? p.action : [p.action];
          for (const a of actions) {
            if (!ACTIONS.has(a)) problems.push(`${at}: action ${a} is not create, update or delete`);
          }
        }
        break;
      case "rpc":
        problems.push(...nsids(at, "lxm", p.lxm, group));
        if (p.aud !== undefined && p.inheritAud === true) {
          problems.push(`${at}: both aud and inheritAud are set, so a PDS ignores it`);
        } else if (p.aud === undefined && p.inheritAud !== true) {
          problems.push(`${at}: needs aud or inheritAud`);
        } else if (p.aud !== undefined && p.aud !== "*") {
          // A set is published once and included by any app, so it can't
          // name one service; the app's include: supplies that through
          // inheritAud.
          problems.push(`${at}: aud must be "*"; use inheritAud for a specific service`);
        }
        break;
      default:
        problems.push(`${at}: resource ${p.resource} is not allowed in a set, only repo and rpc`);
    }
  });
  return problems;
}

function nsids(at: string, field: string, value: unknown, group: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    return [`${at}: ${field} must be a non-empty list of NSIDs`];
  }
  const problems: string[] = [];
  for (const nsid of value) {
    if (typeof nsid === "string" && nsid.includes("*")) {
      problems.push(`${at}: ${field} ${nsid} is a wildcard, which a set may not use`);
    } else if (typeof nsid !== "string" || !NSID.test(nsid)) {
      problems.push(`${at}: ${field} ${nsid} is not an NSID`);
    } else if (!nsid.startsWith(`${group}.`)) {
      problems.push(`${at}: ${field} ${nsid} is outside ${group}`);
    }
  }
  return problems;
}
