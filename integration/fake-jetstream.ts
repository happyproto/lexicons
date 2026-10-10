/**
 * A stand-in for Jetstream. HappyView subscribes over a WebSocket and this
 * replays whatever a test pushes, so a record can reach a `record.index:`
 * trigger without a relay in the stack.
 *
 * Control routes, all under /__:
 *   POST /__emit     one event, or an array of them, broadcast to every
 *                    subscriber. A `commit` shorthand is filled out into the
 *                    envelope Jetstream sends (see `envelope`).
 *   GET  /__subscribers  how many are connected, and what each asked for
 *   POST /__reset    forget the recorded subscriptions
 *
 * `POST /__emit` answers `{delivered}`. Zero means nothing was listening --
 * HappyView reconnects on its own schedule, so a test that emits before the
 * subscription lands would otherwise lose the event and fail somewhere far
 * away. Wait for a subscriber rather than assuming one.
 *
 * The envelope is Jetstream's, whose event discriminant is `kind` and not
 * `type`, and whose cursor is microseconds since the epoch.
 */

type Subscriber = { collections: string[]; at: string };

const subscribers = new Map<unknown, Subscriber>();

/** Fill a shorthand out into the envelope HappyView deserialises. */
function envelope(event: Record<string, unknown>): Record<string, unknown> {
  if (event.kind) return event;

  const commit = event.commit as Record<string, unknown> | undefined;
  if (!commit) throw new Error("an event needs a `kind` or a `commit`");

  return {
    kind: "commit",
    did: event.did,
    // Jetstream's cursor: microseconds, not milliseconds.
    time_us: event.time_us ?? Date.now() * 1000,
    commit: {
      operation: commit.operation ?? "create",
      collection: commit.collection,
      rkey: commit.rkey,
      record: commit.record,
      cid: commit.cid,
    },
  };
}

const server = Bun.serve({
  port: Number(process.env.PORT ?? 6008),

  async fetch(req, srv) {
    const url = new URL(req.url);

    if (url.pathname === "/subscribe") {
      const collections = url.searchParams.getAll("wantedCollections");
      if (srv.upgrade(req, { data: { collections } })) return undefined;
      return new Response("expected a websocket upgrade", { status: 426 });
    }

    switch (`${req.method} ${url.pathname}`) {
      case "GET /__health":
        return Response.json({ ok: true });

      case "GET /__subscribers":
        return Response.json({
          count: subscribers.size,
          subscribers: [...subscribers.values()],
        });

      case "POST /__reset":
        subscribers.clear();
        return Response.json({});

      case "POST /__emit": {
        const body = await req.json();
        const events = Array.isArray(body) ? body : [body];

        let frames: string[];
        try {
          frames = events.map((event) => JSON.stringify(envelope(event)));
        } catch (error) {
          return Response.json({ error: String(error) }, { status: 400 });
        }

        let delivered = 0;
        for (const frame of frames) {
          delivered += srv.publish("jetstream", frame);
        }
        return Response.json({ delivered, events: frames.length });
      }
    }

    return new Response("not found", { status: 404 });
  },

  websocket: {
    open(ws) {
      const { collections } = ws.data as { collections: string[] };
      subscribers.set(ws, { collections, at: new Date().toISOString() });
      ws.subscribe("jetstream");
    },
    close(ws) {
      subscribers.delete(ws);
    },
    // Jetstream never reads from its subscribers.
    message() {},
  },
});

console.log(`fake-jetstream listening on :${server.port}`);
