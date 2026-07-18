// @effect-diagnostics globalFetch:off - narrow loopback relay to the installed gsd-browser viewer.
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { CloseEvent } from "effect/unstable/socket/Socket";

import { browser_preview_manager } from "./browser-preview-manager.ts";

const VIEW_ROUTE = "/api/browser-preview/view";
const SOCKET_ROUTE = "/api/browser-preview/ws";

function read_ticket(request: HttpServerRequest.HttpServerRequest): string | null {
  const url = HttpServerRequest.toURL(request);
  return Option.isSome(url) ? url.value.searchParams.get("ticket") : null;
}

function rewrite_viewer_html(html: string): string {
  return html
    .replaceAll("frame-ancestors 'none'", "frame-ancestors 'self'")
    .replaceAll(
      "'ws://' + location.host + '/ws?'",
      "(location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/api/browser-preview/ws?'",
    );
}

export const browserPreviewViewRouteLayer = HttpRouter.add(
  "GET",
  VIEW_ROUTE,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const ticket = read_ticket(request);
    const entry = ticket ? browser_preview_manager.resolve_ticket(ticket) : null;
    if (!entry) {
      return HttpServerResponse.text("Browser preview ticket is invalid or expired.", {
        status: 401,
      });
    }

    // @effect-diagnostics-next-line globalFetchInEffect:off
    const response = yield* Effect.promise(() => fetch(entry.viewer_url)).pipe(
      Effect.catchDefect(() => Effect.succeed(null)),
    );
    if (!response?.ok) {
      return HttpServerResponse.text("Browser preview is unavailable.", { status: 502 });
    }

    const html = yield* Effect.promise(() => response.text());
    return HttpServerResponse.text(rewrite_viewer_html(html), {
      status: 200,
      contentType: "text/html; charset=utf-8",
      headers: {
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "Content-Security-Policy":
          "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; img-src 'self' data: blob:; frame-ancestors 'self'",
      },
    });
  }),
);

export const browserPreviewSocketRouteLayer = HttpRouter.add(
  "GET",
  SOCKET_ROUTE,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const ticket = read_ticket(request);
    const entry = ticket ? browser_preview_manager.resolve_ticket(ticket) : null;
    if (!entry) {
      return HttpServerResponse.text("Browser preview ticket is invalid or expired.", {
        status: 401,
      });
    }

    const upstream_url = new URL(entry.viewer_url);
    upstream_url.protocol = upstream_url.protocol === "https:" ? "wss:" : "ws:";
    upstream_url.pathname = "/ws";

    return yield* Effect.scoped(
      Effect.gen(function* () {
        const client_socket = yield* request.upgrade;
        const client_writer = yield* client_socket.writer;
        const upstream_closed = yield* Deferred.make<void>();
        const upstream = yield* Effect.acquireRelease(
          Effect.callback<WebSocket>((resume) => {
            const socket = new WebSocket(upstream_url);
            socket.binaryType = "arraybuffer";
            socket.addEventListener("open", () => resume(Effect.succeed(socket)), { once: true });
            socket.addEventListener(
              "error",
              () => resume(Effect.die("Browser preview socket connection failed.")),
              {
                once: true,
              },
            );
            return Effect.sync(() => socket.close());
          }),
          (socket) => Effect.sync(() => socket.close()),
        );

        upstream.addEventListener("message", (event) => {
          const data =
            event.data instanceof ArrayBuffer ? new Uint8Array(event.data) : String(event.data);
          Effect.runFork(client_writer(data));
        });
        upstream.addEventListener("close", (event) => {
          Effect.runFork(client_writer(new CloseEvent(event.code, event.reason)));
          Effect.runFork(Deferred.succeed(upstream_closed, undefined));
        });

        const read_client = client_socket.runRaw((data) => {
          if (upstream.readyState === WebSocket.OPEN) upstream.send(data);
        });
        yield* Effect.race(read_client, Deferred.await(upstream_closed));
        return HttpServerResponse.empty({ status: 101 });
      }),
    ).pipe(
      Effect.catch(() =>
        Effect.succeed(HttpServerResponse.text("Browser preview socket failed.", { status: 502 })),
      ),
    );
  }),
);
