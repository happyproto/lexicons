/**
 * The billing scripts, executed: billing.createCheckout, billing.confirmCheckout
 * and billing.createPortalSession, the billing fields on actor.getAccount and
 * the instance shape, and the billing refusals a create passes through.
 * Generated from source as `bun run gen` does and run under Lua 5.4 against
 * stub modules.
 */
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { expand, parseDirective, parsePrelude, render } from "./gen";
import { HARNESS } from "./harness";
import { findLua } from "./lua";

const lua = findLua();
const skipLua = !lua && Boolean(process.env.ALLOW_SKIP_LUA);
const it = skipLua ? test.skip : test;

const prelude = parsePrelude(await readFile("src/shared/prelude.lua", "utf8"));
async function generated(source: string): Promise<string> {
  const text = await readFile(source, "utf8");
  const blocks = expand(parseDirective(text, source), [...prelude.keys()]);
  return render(source, blocks.map((name) => prelude.get(name)!), text);
}
const SCRIPTS: Record<string, string> = {};
for (const name of [
  "billing/createCheckout",
  "billing/confirmCheckout",
  "billing/createPortalSession",
  "billing/resume",
  "actor/getAccount",
  "server/createInstance",
  "server/startInstance",
  "server/updateInstance",
  "server/getInstance",
  "server/listPlans",
]) {
  SCRIPTS[name] = await generated(`src/at/happyproto/${name}.lua`);
}

const HP = "did:plc:hp";
const CUSTOMERS = `at://${HP}/space/at.happyproto.customers/main`;
const KEY = "4f0c2e3a-1b2c-4d5e-8f90-123456789abc";
const ID = "11111111-1111-4111-8111-111111111111";
const envOf = (extra = "") => `{ HAPPYPROTO_DID = "${HP}", PROVISIONER_URL = "http://provisioner:8080/", PROVISIONER_TOKEN = "tok"${extra} }`;

/**
 * Run `script` with `input` (a Lua table literal). `replies` maps a URL
 * suffix to `{status, body}`, where body is a Lua table literal the stub JSON
 * decoder hands back; anything unmatched is a 500.
 */
function run(
  script: string,
  input: string,
  replies: Record<string, { status: number; body: string }> = {},
  { customer = true, env = "" }: { customer?: boolean; env?: string } = {},
): { out: any; calls: any[] } {
  if (!lua) {
    throw new Error(
      "no lua on PATH, so the billing scripts were never executed. " +
        "Install Lua (macOS: brew install lua; Ubuntu: apt-get install -y lua5.4). " +
        "To run deliberately without it, set ALLOW_SKIP_LUA=1.",
    );
  }
  const entries = Object.entries(replies);
  const decoded = entries.map(([, r], i) => `__decoded['{"r":${i}}'] = ${r.body}`);
  // A key is a URL suffix, optionally after a method: "patch /v1/tenants/x".
  const routes = entries
    .map(([route, r], i) => {
      const [, method, suffix] = route.match(/^(?:(get|post|patch|delete) )?(.*)$/)!;
      const when = method ? `method == "${method}" and ` : "";
      return `if ${when}url:sub(-${suffix.length}) == "${suffix}" then return { status = ${r.status}, body = '{"r":${i}}', headers = {} } end`;
    })
    .join("\n  ");
  const source = [
    HARNESS,
    SCRIPTS[script],
    `__access = function(uri, did) return ${customer ? `uri == "${CUSTOMERS}" and "read" or nil` : "nil"} end`,
    ...decoded,
    `__reply = function(method, url, opts)\n  ${routes}\n  return { status = 500, body = "", headers = {} }\nend`,
    `local out = handle(${input}, { caller_did = "did:plc:alice", env = ${envOf(env)} })`,
    `io.write(__encode({ out = out, calls = __calls }))`,
  ].join("\n\n");
  const result = Bun.spawnSync([lua, "-"], { stdin: new TextEncoder().encode(source) });
  if (result.exitCode !== 0) {
    throw new Error(`lua exited ${result.exitCode}:\n${new TextDecoder().decode(result.stderr)}`);
  }
  const parsed = JSON.parse(new TextDecoder().decode(result.stdout));
  return { out: parsed.out, calls: Array.isArray(parsed.calls) ? parsed.calls : [] };
}

const sent = (calls: any[]) =>
  calls.filter((c) => c.fn !== "get" || !c.url.includes("/space")).map((c) => `${c.fn} ${c.url}`);
const bodyOf = (call: any) => JSON.parse(call?.opts?.body ?? "null");
const refusal = (error: string, message = "said by the provisioner") =>
  `{ error = "${error}", message = "${message}" }`;

const BILLING = `{
  status = "trialing", clamped = true, provider = "stripe_mp", exempt = false, hold = "null", has_payment_method = false,
  cancel_at_period_end = false, trial_ends_at = "2026-12-21T15:00:00Z",
  current_period_end = "2026-12-21T15:00:00Z", discount_stage = "",
  credit_code = { reserved = true, applied = false },
  plans_on_subscription = { { plan = "pro", quantity = 1 } },
  customer_id = "cus_secret",
}`;
const PUBLIC_BILLING = {
  status: "trialing",
  clamped: true,
  exempt: false,
  hasPaymentMethod: false,
  cancelAtPeriodEnd: false,
  trialEndsAt: "2026-12-21T15:00:00Z",
  currentPeriodEnd: "2026-12-21T15:00:00Z",
  creditCode: { reserved: true, applied: false },
  plans: [{ plan: "pro", quantity: 1 }],
};

describe("billing.createCheckout", () => {
  const input = (extra = "") => `{ plan = "pro", idempotencyKey = "${KEY}"${extra} }`;
  const checkout = {
    "/v1/billing/checkout": {
      status: 200,
      body: `{ url = "https://checkout.stripe.com/c/pay/cs_test_1", session_id = "cs_test_1", expires_at = "2026-11-26T15:00:00Z" }`,
    },
  };

  it("asks the provisioner for a Checkout and returns only its URL", () => {
    const { out, calls } = run("billing/createCheckout", input(`, code = "WL-12345678"`), checkout);
    expect(out).toEqual({
      url: "https://checkout.stripe.com/c/pay/cs_test_1",
      sessionId: "cs_test_1",
      expiresAt: "2026-11-26T15:00:00Z",
    });
    const post = calls.find((c) => c.fn === "post");
    expect(post.url).toBe("http://provisioner:8080/v1/billing/checkout");
    expect(post.opts.headers["Idempotency-Key"]).toBe(KEY);
    expect(bodyOf(post)).toEqual({ plan: "pro", code: "WL-12345678", with_card: false });
  });

  it("withCard asks for a card now", () => {
    const { calls } = run("billing/createCheckout", input(", withCard = true"), checkout);
    expect(bodyOf(calls.find((c) => c.fn === "post"))).toEqual({ plan: "pro", with_card: true });
  });

  it("refuses a bad plan, code, withCard or key before asking the provisioner", () => {
    for (const bad of [
      `{ plan = "", idempotencyKey = "${KEY}" }`,
      `{ plan = "${"p".repeat(65)}", idempotencyKey = "${KEY}" }`,
      `{ plan = "pro", withCard = "yes", idempotencyKey = "${KEY}" }`,
      `{ plan = "pro", idempotencyKey = "nope" }`,
      `{ plan = "pro", code = "${"x".repeat(65)}", idempotencyKey = "${KEY}" }`,
    ]) {
      const { out, calls } = run("billing/createCheckout", bad, checkout);
      expect(out.error).toBe("InvalidRequest");
      expect(calls.filter((c) => c.fn === "post")).toEqual([]);
    }
  });

  it("hands back only an https URL on a Stripe host", () => {
    for (const url of [
      "http://checkout.stripe.com/x",
      "javascript:alert(1)//",
      "https://user@checkout.stripe.com/x",
      "https://checkout.stripe.com.example.net/x",
      "https://example.com/x",
    ]) {
      const { out } = run("billing/createCheckout", input(), {
        "/v1/billing/checkout": { status: 200, body: `{ url = "${url}" }` },
      });
      expect(out.error).toBe("Upstream");
    }
  });

  it("HAPPYPROTO_BILLING_URL_HOSTS replaces the allowed hosts", () => {
    const reply = { "/v1/billing/checkout": { status: 200, body: `{ url = "https://pay.happyproto.at/c/1" }` } };
    expect(run("billing/createCheckout", input(), reply, { env: `, HAPPYPROTO_BILLING_URL_HOSTS = "pay.happyproto.at"` }).out.url).toBe(
      "https://pay.happyproto.at/c/1",
    );
    expect(run("billing/createCheckout", input(), reply).out.error).toBe("Upstream");
    const stripe = run("billing/createCheckout", input(), checkout, { env: `, HAPPYPROTO_BILLING_URL_HOSTS = "pay.happyproto.at"` });
    expect(stripe.out.error).toBe("Upstream");
  });

  it("passes the billing refusals through in its own words, and is customers only", () => {
    for (const [status, code] of [
      [409, "AlreadySubscribed"],
      [400, "InvalidCode"],
      [400, "CodeUsed"],
      [400, "CodeExpired"],
      [409, "TrialPoolFull"],
      [503, "BillingUnavailable"],
    ] as const) {
      const { out } = run("billing/createCheckout", input(), {
        "/v1/billing/checkout": { status, body: refusal(code, "provisioner detail") },
      });
      expect(out.error).toBe(code);
      expect(out.message).not.toContain("provisioner detail");
    }
    const outsider = run("billing/createCheckout", input(), checkout, { customer: false });
    expect(outsider.out.error).toBe("Forbidden");
    expect(outsider.calls.filter((c) => c.fn === "post")).toEqual([]);
  });

  it("an unknown provisioner code is Upstream, with nothing of its body", () => {
    const { out } = run("billing/createCheckout", input(), {
      "/v1/billing/checkout": { status: 500, body: refusal("SomethingInternal", "internal detail") },
    });
    expect(out).toEqual({ error: "Upstream", message: "The provisioner could not complete the request." });
  });
});

describe("billing.confirmCheckout", () => {
  const input = (id = "cs_test_a1B2") => `{ sessionId = "${id}", idempotencyKey = "${KEY}" }`;

  it("confirms the session and returns the account's billing, field by field", () => {
    const { out, calls } = run("billing/confirmCheckout", input(), {
      "/v1/billing/checkout/confirm": { status: 200, body: BILLING },
    });
    expect(out).toEqual({ billing: PUBLIC_BILLING });
    expect(bodyOf(calls.find((c) => c.fn === "post"))).toEqual({ session_id: "cs_test_a1B2" });
  });

  it("refuses anything that isn't a Checkout Session id", () => {
    for (const id of ["", "pi_123", "cs_../../admin", `cs_${"a".repeat(260)}`]) {
      const { out, calls } = run("billing/confirmCheckout", input(id));
      expect(out.error).toBe("InvalidRequest");
      expect(calls.filter((c) => c.fn === "post")).toEqual([]);
    }
  });

  it("someone else's session is refused in the provisioner's terms", () => {
    const { out } = run("billing/confirmCheckout", input(), {
      "/v1/billing/checkout/confirm": { status: 403, body: refusal("Forbidden", "not yours") },
    });
    expect(out.error).toBe("Forbidden");
  });

  it("passes CheckoutNotComplete and CheckoutExpired through", () => {
    for (const code of ["CheckoutNotComplete", "CheckoutExpired"]) {
      const { out } = run("billing/confirmCheckout", input(), {
        "/v1/billing/checkout/confirm": { status: 400, body: refusal(code) },
      });
      expect(out.error).toBe(code);
    }
  });
});

describe("billing.createPortalSession", () => {
  const portal = { "/v1/billing/portal": { status: 200, body: `{ url = "https://billing.stripe.com/p/session/x" }` } };

  it("asks for the card form, or the Portal home", () => {
    const card = run("billing/createPortalSession", `{ flow = "paymentMethod", idempotencyKey = "${KEY}" }`, portal);
    expect(card.out).toEqual({ url: "https://billing.stripe.com/p/session/x" });
    expect(bodyOf(card.calls.find((c) => c.fn === "post"))).toEqual({ flow: "payment_method_update" });
    const home = run("billing/createPortalSession", `{ idempotencyKey = "${KEY}" }`, portal);
    expect(home.out.url).toBe("https://billing.stripe.com/p/session/x");
    expect(bodyOf(home.calls.find((c) => c.fn === "post"))).toEqual({});
  });

  it("cancel goes straight to the Portal's cancel flow", () => {
    const { out, calls } = run("billing/createPortalSession", `{ flow = "cancel", idempotencyKey = "${KEY}" }`, portal);
    expect(out.url).toBe("https://billing.stripe.com/p/session/x");
    expect(bodyOf(calls.find((c) => c.fn === "post"))).toEqual({ flow: "subscription_cancel" });
  });

  it("refuses an unknown flow before asking the provisioner", () => {
    const { out, calls } = run("billing/createPortalSession", `{ flow = "manage", idempotencyKey = "${KEY}" }`, portal);
    expect(out.error).toBe("InvalidRequest");
    expect(calls.filter((c) => c.fn === "post")).toEqual([]);
  });

  it("cancelling with no plan running is NoSubscription", () => {
    const { out } = run("billing/createPortalSession", `{ flow = "cancel", idempotencyKey = "${KEY}" }`, {
      "/v1/billing/portal": { status: 409, body: refusal("NoSubscription") },
    });
    expect(out.error).toBe("NoSubscription");
  });

  it("an account without a billing account is NoBillingAccount", () => {
    const { out } = run("billing/createPortalSession", `{ idempotencyKey = "${KEY}" }`, {
      "/v1/billing/portal": { status: 409, body: refusal("NoBillingAccount") },
    });
    expect(out.error).toBe("NoBillingAccount");
  });
});

describe("actor.getAccount", () => {
  const account = (extra: string) => ({
    "/v1/account": { status: 200, body: `{ instance_count = 1, instance_limit = 3${extra} }` },
  });

  it("carries the account's billing and whether the trial pool is full", () => {
    const { out } = run("actor/getAccount", "{}", account(`, billing = ${BILLING}, trial = { card_free = true, instance_limit = 1, resource_plan = "small", pool_full = true }`));
    expect(out.billing).toEqual(PUBLIC_BILLING);
    expect(out.trialPoolFull).toBe(true);
  });

  it("carries a hold's reason, and drops one it doesn't know", () => {
    const held = run("actor/getAccount", "{}", account(`, billing = { status = "paused", hold = { at = "2026-12-21T15:00:00Z", reason = "trial_paused" } }`));
    expect(held.out.billing.hold).toEqual({ reason: "trial_paused", at: "2026-12-21T15:00:00Z" });
    const odd = run("actor/getAccount", "{}", account(`, billing = { status = "paused", hold = { reason = "other" } }`));
    expect(odd.out.billing.hold).toBeUndefined();
  });

  it("leaves a staff unclamp wait out, and names a trial wait", () => {
    const wait = (kind: string) =>
      run("actor/getAccount", "{}", account(`, capacity_wait = { plan = "pro", queued_at = "2026-12-08T00:00:00Z", kind = "${kind}" }`)).out
        .capacityWait;
    expect(wait("unclamp")).toBeUndefined();
    expect(wait("trial")).toMatchObject({ plan: "pro", kind: "trial" });
  });

  it("carries a canceled hold", () => {
    const { out } = run("actor/getAccount", "{}", account(`, billing = { status = "canceled", hold = { at = "2026-12-21T15:00:00Z", reason = "canceled" } }`));
    expect(out.billing.hold).toEqual({ reason: "canceled", at: "2026-12-21T15:00:00Z" });
  });

  it("leaves billing out while billing is off", () => {
    const { out } = run("actor/getAccount", "{}", account(""));
    expect(out.billing).toBeUndefined();
    expect(out.trialPoolFull).toBe(false);
  });

  it("keeps only well-formed billed plans and timestamps", () => {
    const { out } = run(
      "actor/getAccount",
      "{}",
      account(
        `, billing = { status = "active", trial_ends_at = "soon", plans_on_subscription = { { plan = "pro" }, { plan = "x", quantity = -1 }, { plan = "y", quantity = 1.5 }, { plan = "hobby", quantity = 2 }, { plan = "pro", quantity = 3.0 } } }`,
      ),
    );
    expect(out.billing.plans).toEqual([
      { plan: "hobby", quantity: 2 },
      { plan: "pro", quantity: 3 },
    ]);
    expect(out.billing.trialEndsAt).toBeUndefined();
  });

  it("passes only whole RFC 3339 timestamps, and no discount stage of none", () => {
    for (const [at, kept] of [
      ["2026-12-21T15:00:00Z", true],
      ["2026-12-21T15:00:00.123+01:00", true],
      ["2026-12-21T15:00:00junk", false],
      ["2026-12-21T15:00:00", false],
    ] as const) {
      const { out } = run("actor/getAccount", "{}", account(`, billing = { status = "trialing", trial_ends_at = "${at}", discount_stage = "none" }`));
      expect(out.billing.trialEndsAt).toBe(kept ? at : undefined);
      expect(out.billing.discountStage).toBeUndefined();
    }
  });
});

describe("the instance shape", () => {
  const tenant = (extra: string) => `{ tenant = {
    id = "${ID}", slug = "app", owner_did = "did:plc:alice", plan_id = "pro",
    happyview_version = "v", public_url = "https://app.hpy.at", created_at = "2026-11-25T00:00:00Z",
    desired_state = "stopped", observed_state = "stopped"${extra}
  } }`;

  it("reports the plan a trial runs at, why it was stopped, and a wait for room", () => {
    const { out } = run("server/getInstance", `{ id = "${ID}" }`, {
      [`/v1/tenants/${ID}`]: {
        status: 200,
        body: tenant(`, resource_plan_id = "small", stopped_by_trial_idle = true, stopped_by_billing = false, clamp_waiting_for_room = true`),
      },
    });
    expect(out.instance).toMatchObject({ plan: "pro", servedPlan: "small", stoppedFor: "trialIdle", waitingForRoom: true });
  });

  it("reports stoppedFor only while the instance is stopped", () => {
    const { out } = run("server/getInstance", `{ id = "${ID}" }`, {
      [`/v1/tenants/${ID}`]: {
        status: 200,
        body: tenant(`, stopped_by_billing = true`).replace('desired_state = "stopped", observed_state = "stopped"', 'desired_state = "running", observed_state = "running"'),
      },
    });
    expect(out.instance.stoppedFor).toBeUndefined();
  });

  it("leaves them out when the instance runs its own plan and the owner stopped it", () => {
    const { out } = run("server/getInstance", `{ id = "${ID}" }`, {
      [`/v1/tenants/${ID}`]: { status: 200, body: tenant(`, resource_plan_id = "pro", stopped_by_billing = false, stopped_by_trial_idle = false`) },
    });
    expect(out.instance.servedPlan).toBeUndefined();
    expect(out.instance.stoppedFor).toBeUndefined();
    expect(out.instance.waitingForRoom).toBeUndefined();
  });
});

describe("billing refusals on instance changes", () => {
  it("a create passes PaymentRequired, CardRequired and TrialPoolFull through", () => {
    for (const [status, code] of [
      [402, "PaymentRequired"],
      [403, "CardRequired"],
      [409, "TrialPoolFull"],
      [403, "BillingHold"],
    ] as const) {
      const { out } = run("server/createInstance", `{ slug = "my-app", plan = "pro", idempotencyKey = "${KEY}" }`, {
        "/v1/tenants": { status, body: refusal(code) },
      });
      expect(out.error).toBe(code);
    }
  });

  it("a start after a trial's idle stop can find the pool full", () => {
    const { out } = run("server/startInstance", `{ id = "${ID}", idempotencyKey = "${KEY}" }`, {
      [`/v1/tenants/${ID}`]: {
        status: 200,
        body: `{ tenant = { id = "${ID}", owner_did = "did:plc:alice" } }`,
      },
      [`/v1/tenants/${ID}/start`]: { status: 409, body: refusal("TrialPoolFull") },
    });
    expect(out.error).toBe("TrialPoolFull");
  });

  it("a plan change passes PaymentRequired and CardRequired through", () => {
    for (const [status, code] of [
      [402, "PaymentRequired"],
      [403, "CardRequired"],
    ] as const) {
      const { out } = run("server/updateInstance", `{ id = "${ID}", plan = "pro", idempotencyKey = "${KEY}" }`, {
        [`patch /v1/tenants/${ID}`]: { status, body: refusal(code) },
        [`get /v1/tenants/${ID}`]: { status: 200, body: `{ tenant = { id = "${ID}", owner_did = "did:plc:alice" } }` },
      });
      expect(out.error).toBe(code);
    }
  });
});

describe("server.listPlans", () => {
  it("carries a priced plan's tier, price and allowances, and leaves them out of an unpriced one", () => {
    const { out } = run("server/listPlans", "{}", {
      "/v1/plans": {
        status: 200,
        body: `{ plans = {
          { id = "pro", name = "Pro", memory_mb = 1024, cpu_millis = 1000, disk_gb = 10, tier = "pro",
            price_cents = 4000, currency = "usd", included_live_records = 25000000,
            included_backfill_records = 250000000, limit_seats = 5, limit_log_retention_days = 7, hook_workers = 4, job_worker_concurrency = 2, stripe_price_id = "price_x" },
          { id = "small", name = "Small", memory_mb = 512, cpu_millis = 500, disk_gb = 5, tier = "", price_cents = -1 },
        } }`,
      },
    });
    expect(out.plans).toEqual([
      {
        id: "pro",
        name: "Pro",
        memoryMb: 1024,
        cpuMillis: 1000,
        diskGb: 10,
        tier: "pro",
        priceCents: 4000,
        currency: "usd",
        includedLiveRecords: 25000000,
        includedBackfillRecords: 250000000,
        seats: 5,
        logRetentionDays: 7,
        hookWorkers: 4,
        jobWorkers: 2,
      },
      { id: "small", name: "Small", memoryMb: 512, cpuMillis: 500, diskGb: 5 },
    ]);
  });
});

describe("billing.resume", () => {
  it("asks the provisioner to resume, and returns billing as it stands", () => {
    const { out, calls } = run("billing/resume", `{ idempotencyKey = "${KEY}" }`, {
      "/v1/billing/resume": { status: 200, body: `{ status = "paused", hold = { reason = "trial_paused", at = "2026-12-21T15:00:00Z" }, has_payment_method = true }` },
    });
    expect(out.billing).toMatchObject({ status: "paused", hasPaymentMethod: true, hold: { reason: "trial_paused" } });
    const post = calls.find((c) => c.fn === "post");
    expect(post.url).toBe("http://provisioner:8080/v1/billing/resume");
    expect(post.opts.headers["Idempotency-Key"]).toBe(KEY);
  });

  it("no card yet is CardRequired, and a bad key asks nothing", () => {
    expect(
      run("billing/resume", `{ idempotencyKey = "${KEY}" }`, {
        "/v1/billing/resume": { status: 409, body: refusal("CardRequired") },
      }).out.error,
    ).toBe("CardRequired");
    const bad = run("billing/resume", `{ idempotencyKey = "nope" }`);
    expect(bad.out.error).toBe("InvalidRequest");
    expect(bad.calls.filter((c) => c.fn === "post")).toEqual([]);
  });
});
