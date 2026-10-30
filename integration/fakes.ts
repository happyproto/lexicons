/** Test-side handles on the two fakes' control routes. */
import { CLICKHOUSE_URL, PROVISIONER_URL } from "./setup";

async function post(url: string, body?: unknown): Promise<void> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok) throw new Error(`${url} answered ${res.status}: ${await res.text()}`);
}

export type ProvisionerRequest = {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: any;
};

export const provisioner = {
  reset: () => post(`${PROVISIONER_URL}/__reset`),
  /** Seed tenants, operations, plans, hosts, staff DIDs and the instance limit. */
  state: (state: {
    tenants?: any[];
    operations?: any[];
    plans?: any[];
    hosts?: any[];
    staff?: string[];
    instanceLimit?: number;
    entitlementMode?: "invite" | "staff";
    invites?: any[];
    /** CUSTOM_DOMAINS_ENABLED; off unless set. */
    customDomains?: boolean;
    /** Domain rows: the API's Domain shape plus tenant_id (and removed: true). */
    domains?: any[];
    /** GET /v1/autoscale's answer; PATCH changes paused on it. */
    autoscale?: any;
    /** Host requests as GET /v1/host-requests/:id answers them, events included. */
    hostRequests?: any[];
    /** GET /v1/tenants/:id/logs's page, by tenant id. */
    logs?: Record<string, any>;
  }) => post(`${PROVISIONER_URL}/__state`, state),
  /** The next `method path` request gets this reply, once. */
  script: (method: string, path: string, status: number, body: unknown) =>
    post(`${PROVISIONER_URL}/__script`, { method, path, status, body }),
  /** The next `method path` request gets no reply at all, once. */
  drop: (method: string, path: string) =>
    post(`${PROVISIONER_URL}/__script`, { method, path, status: 500, body: null, drop: true }),
  /**
   * The states the next operation a mutating route creates moves through,
   * one per read of it, holding at the last. `{ http, error? }` fails that
   * read with that status and code instead. Unscripted, it succeeds at once.
   */
  progress: (
    states: (
      | { status: string; step?: string; error_code?: string; error_message?: string }
      | { http: number; error?: string }
    )[],
  ) => post(`${PROVISIONER_URL}/__progress`, states),
  async requests(): Promise<ProvisionerRequest[]> {
    return (await fetch(`${PROVISIONER_URL}/__requests`)).json() as Promise<ProvisionerRequest[]>;
  },
};

export const clickhouse = {
  reset: () => post(`${CLICKHOUSE_URL}/__reset`),
  /** Any SQL containing `match` is answered with `data`. */
  rows: (match: string, data: unknown[]) => post(`${CLICKHOUSE_URL}/__rows`, { match, data }),
  async queries(): Promise<{ sql: string; params: Record<string, string> }[]> {
    return (await fetch(`${CLICKHOUSE_URL}/__queries`)).json() as Promise<any>;
  },
};
