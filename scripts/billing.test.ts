/**
 * The billing scripts, executed: actor.createCheckout, actor.confirmCheckout
 * and actor.createBillingPortal, the billing fields on actor.getAccount and
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
  "actor/createCheckout",
  "actor/confirmCheckout",
  "actor/createBillingPortal",
  "actor/getAccount",
  "server/createInstance",
  "server/startInstance",
  "server/getInstance",
  "server/listPlans",
]) {
  SCRIPTS[name] = await generated(`src/at/happyproto/${name}.lua`);
}

const HP = "did:plc:hp";
const CUSTOMERS = `at://${HP}/space/at.happyproto.customers/main`;
const KEY = "4f0c2e3a-1b2c-4d5e-8f90-123456789abc";
const ID = "11111111-1111-4111-8111-111111111111";
const ENV = `{ HAPPYPROTO_DID = "${HP}", PROVISIONER_URL = "http://provisioner:8080/", PROVISIONER_TOKEN = "tok" }`;

/**
 * Run `script` with `input` (a Lua table literal). `replies` maps a URL
 * suffix to `{status, body}`, where body is a Lua table literal the stub JSON
 * decoder hands back; anything unmatched is a 500.
 */
function run(
  script: string,
  input: string,
  replies: Record<string, { status: number; body: string }> = {},
  { customer = true }: { customer?: boolean } = {},
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
  const routes = entries
    .map(([suffix, r], i) => `if url:sub(-${suffix.length}) == "${suffix}" then return { status = ${r.status}, body = '{"r":${i}}', headers = {} } end`)
    .join("\n  ");
  const source = [
    HARNESS,
    SCRIPTS[script],
    `__access = function(uri, did) return ${customer ? `uri == "${CUSTOMERS}" and "read" or nil` : "nil"} end`,
    ...decoded,
    `__reply = function(method, url, opts)\n  ${routes}\n  return { status = 500, body = "", headers = {} }\nend`,
    `local out = handle(${input}, { caller_did = "did:plc:alice", env = ${ENV} })`,
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
  status = "trialing", exempt = false, hold = false, has_payment_method = false,
  cancel_at_period_end = false, credit_balance_cents = 1000,
  trial_ends_at = "2026-12-21T15:00:00Z", current_period_end = "2026-12-21T15:00:00Z",
  plans = { { plan = "pro", quantity = 1 } },
  stripe_customer_id = "cus_secret",
}`;
const PUBLIC_BILLING = {
  status: "trialing",
  exempt: false,
  hold: false,
  hasPaymentMethod: false,
  cancelAtPeriodEnd: false,
  creditBalanceCents: 1000,
  trialEndsAt: "2026-12-21T15:00:00Z",
  currentPeriodEnd: "2026-12-21T15:00:00Z",
  plans: [{ plan: "pro", quantity: 1 }],
};

describe("actor.createCheckout", () => {
  const input = (extra = "") => `{ plan = "pro", payment = "trial", idempotencyKey = "${KEY}"${extra} }`;
  const checkout = {
    "/v1/billing/checkout": {
      status: 200,
      body: `{ url = "https://checkout.stripe.com/c/pay/cs_test_1", session_id = "cs_test_1", expires_at = "2026-11-26T15:00:00Z" }`,
    },
  };

  it("asks the provisioner for a Checkout and returns only its URL", () => {
    const { out, calls } = run("actor/createCheckout", input(`, code = "WAIT-1234"`), checkout);
    expect(out).toEqual({ url: "https://checkout.stripe.com/c/pay/cs_test_1", expiresAt: "2026-11-26T15:00:00Z" });
    const post = calls.find((c) => c.fn === "post");
    expect(post.url).toBe("http://provisioner:8080/v1/billing/checkout");
    expect(post.opts.headers["Idempotency-Key"]).toBe(KEY);
    expect(bodyOf(post)).toEqual({ plan: "pro", payment: "trial", code: "WAIT-1234" });
  });

  it("refuses a bad payment, plan, code or key before asking the provisioner", () => {
    for (const bad of [
      `{ plan = "pro", payment = "later", idempotencyKey = "${KEY}" }`,
      `{ plan = "", payment = "card", idempotencyKey = "${KEY}" }`,
      `{ plan = "pro", payment = "card", idempotencyKey = "nope" }`,
      `{ plan = "pro", payment = "card", code = "${"x".repeat(65)}", idempotencyKey = "${KEY}" }`,
    ]) {
      const { out, calls } = run("actor/createCheckout", bad, checkout);
      expect(out.error).toBe("InvalidRequest");
      expect(calls.filter((c) => c.fn === "post")).toEqual([]);
    }
  });

  it("never hands back a URL that isn't https", () => {
    for (const url of ["http://checkout.stripe.com/x", "javascript:alert(1)//", "https://user@evil.example/x"]) {
      const { out } = run("actor/createCheckout", input(), {
        "/v1/billing/checkout": { status: 200, body: `{ url = "${url}" }` },
      });
      expect(out.error).toBe("Upstream");
    }
  });

  it("passes the billing refusals through, and is customers only", () => {
    for (const code of ["BillingUnavailable", "CodeInvalid", "CodeUsed", "TrialPoolFull"]) {
      const { out } = run("actor/createCheckout", input(), {
        "/v1/billing/checkout": { status: 409, body: refusal(code) },
      });
      expect(out).toEqual({ error: code, message: "said by the provisioner" });
    }
    const outsider = run("actor/createCheckout", input(), checkout, { customer: false });
    expect(outsider.out.error).toBe("Forbidden");
    expect(outsider.calls.filter((c) => c.fn === "post")).toEqual([]);
  });

  it("an unknown provisioner code is Upstream, with nothing of its body", () => {
    const { out } = run("actor/createCheckout", input(), {
      "/v1/billing/checkout": { status: 500, body: refusal("StripeKeyInvalid", "sk_live_leaked") },
    });
    expect(out).toEqual({ error: "Upstream", message: "The provisioner could not complete the request." });
  });
});

describe("actor.confirmCheckout", () => {
  const input = (id = "cs_test_a1B2") => `{ sessionId = "${id}", idempotencyKey = "${KEY}" }`;

  it("confirms the session and returns the account's billing, field by field", () => {
    const { out, calls } = run("actor/confirmCheckout", input(), {
      "/v1/billing/checkout/confirm": { status: 200, body: `{ billing = ${BILLING} }` },
    });
    expect(out).toEqual({ billing: PUBLIC_BILLING });
    const post = calls.find((c) => c.fn === "post");
    expect(bodyOf(post)).toEqual({ session_id: "cs_test_a1B2" });
  });

  it("refuses anything that isn't a Checkout Session id", () => {
    for (const id of ["", "pi_123", "cs_../../admin", `cs_${"a".repeat(260)}`]) {
      const { out, calls } = run("actor/confirmCheckout", input(id));
      expect(out.error).toBe("InvalidRequest");
      expect(calls.filter((c) => c.fn === "post")).toEqual([]);
    }
  });

  it("passes CheckoutIncomplete and CheckoutExpired through", () => {
    for (const code of ["CheckoutIncomplete", "CheckoutExpired"]) {
      const { out } = run("actor/confirmCheckout", input(), {
        "/v1/billing/checkout/confirm": { status: 409, body: refusal(code) },
      });
      expect(out.error).toBe(code);
    }
  });
});

describe("actor.createBillingPortal", () => {
  it("maps the flow to the provisioner's name for it", () => {
    for (const [flow, wire] of [
      ["paymentMethod", "payment_method_update"],
      ["manage", "manage"],
    ]) {
      const { out, calls } = run("actor/createBillingPortal", `{ flow = "${flow}", idempotencyKey = "${KEY}" }`, {
        "/v1/billing/portal": { status: 200, body: `{ url = "https://billing.stripe.com/p/session/x" }` },
      });
      expect(out).toEqual({ url: "https://billing.stripe.com/p/session/x" });
      expect(bodyOf(calls.find((c) => c.fn === "post"))).toEqual({ flow: wire });
    }
  });

  it("refuses an unknown flow before asking the provisioner", () => {
    const { out, calls } = run("actor/createBillingPortal", `{ flow = "payment_method_update", idempotencyKey = "${KEY}" }`);
    expect(out.error).toBe("InvalidRequest");
    expect(calls.filter((c) => c.fn === "post")).toEqual([]);
  });
});

describe("actor.getAccount", () => {
  const account = (extra: string) => ({
    "/v1/account": { status: 200, body: `{ instance_count = 1, instance_limit = 3${extra} }` },
  });

  it("carries the account's billing and whether the trial pool is full", () => {
    const { out } = run("actor/getAccount", "{}", account(`, billing = ${BILLING}, trial_pool_full = true`));
    expect(out.billing).toEqual(PUBLIC_BILLING);
    expect(out.trialPoolFull).toBe(true);
  });

  it("leaves billing out while billing is off", () => {
    const { out } = run("actor/getAccount", "{}", account(""));
    expect(out.billing).toBeUndefined();
    expect(out.trialPoolFull).toBe(false);
  });

  it("never reports a negative credit or a malformed billed plan", () => {
    const { out } = run(
      "actor/getAccount",
      "{}",
      account(`, billing = { status = "active", credit_balance_cents = -500, plans = { { plan = "pro" }, { plan = "hobby", quantity = 2 } } }`),
    );
    expect(out.billing.creditBalanceCents).toBe(0);
    expect(out.billing.plans).toEqual([{ plan: "hobby", quantity: 2 }]);
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
        body: tenant(`, resource_plan_id = "hobby", stopped_reason = "trial_idle", clamp_waiting_for_room = true`),
      },
    });
    expect(out.instance).toMatchObject({ plan: "pro", servedPlan: "hobby", stoppedFor: "trialIdle", waitingForRoom: true });
  });

  it("leaves them out when the instance runs its own plan and the owner stopped it", () => {
    const { out } = run("server/getInstance", `{ id = "${ID}" }`, {
      [`/v1/tenants/${ID}`]: { status: 200, body: tenant(`, resource_plan_id = "pro", stopped_reason = "owner"`) },
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
      [402, "CardRequired"],
      [503, "TrialPoolFull"],
      [402, "AccountOnHold"],
    ] as const) {
      const { out } = run("server/createInstance", `{ slug = "my-app", plan = "pro", idempotencyKey = "${KEY}" }`, {
        "/v1/tenants": { status, body: refusal(code) },
      });
      expect(out).toEqual({ error: code, message: "said by the provisioner" });
    }
  });

  it("a start after a trial's idle stop can find the pool full", () => {
    const { out } = run("server/startInstance", `{ id = "${ID}", idempotencyKey = "${KEY}" }`, {
      [`/v1/tenants/${ID}`]: {
        status: 200,
        body: `{ tenant = { id = "${ID}", owner_did = "did:plc:alice" } }`,
      },
      [`/v1/tenants/${ID}/start`]: { status: 503, body: refusal("TrialPoolFull") },
    });
    expect(out.error).toBe("TrialPoolFull");
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
            included_backfill_records = 250000000, log_retention_days = 7, stripe_price_id = "price_x" },
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
        logRetentionDays: 7,
      },
      { id: "small", name: "Small", memoryMb: 512, cpuMillis: 500, diskGb: 5 },
    ]);
  });
});
