/**
 * A stand-in for ClickHouse's HTTP interface. Every query is answered with
 * canned `{data: [...]}` rows, chosen by a substring of the SQL.
 *
 * Control routes, all under /__:
 *   POST /__rows     { match, data }: any SQL containing `match` gets `data`.
 *                    Later registrations win, so a test can override one.
 *   GET  /__queries  every query received since the last reset
 *   POST /__reset    clear rows and queries
 *
 * SQL that matches nothing gets `{data: []}`, which is what ClickHouse says
 * for an empty table. Credentials must arrive as the x-clickhouse-* headers
 * the prelude sends, or it answers 403 the way ClickHouse does.
 */

type Rows = { match: string; data: unknown[] };

const USER = process.env.CLICKHOUSE_USER ?? "integration";
const KEY = process.env.CLICKHOUSE_PASSWORD ?? "integration-clickhouse-password";

let rows: Rows[] = [];
let queries: { sql: string; params: Record<string, string> }[] = [];

const server = Bun.serve({
  port: Number(process.env.PORT ?? 8123),
  async fetch(req) {
    const url = new URL(req.url);
    switch (`${req.method} ${url.pathname}`) {
      case "GET /__health":
        return Response.json({ ok: true });
      case "GET /__queries":
        return Response.json(queries);
      case "POST /__reset":
        rows = [];
        queries = [];
        return Response.json({});
      case "POST /__rows":
        rows.unshift((await req.json()) as Rows);
        return Response.json({});
    }

    if (
      req.headers.get("x-clickhouse-user") !== USER ||
      req.headers.get("x-clickhouse-key") !== KEY
    ) {
      return new Response("Code: 516. DB::Exception: Authentication failed", { status: 403 });
    }

    const sql = await req.text();
    queries.push({ sql, params: Object.fromEntries(url.searchParams) });
    const found = rows.find((r) => sql.includes(r.match));
    return Response.json({ data: found?.data ?? [] });
  },
});

console.log(`fake clickhouse listening on ${server.port}`);
