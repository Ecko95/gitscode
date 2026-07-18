import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as DesktopSshEnvironment from "../../ssh/DesktopSshEnvironment.ts";
import { openRemoteSshUrl } from "./window.ts";

describe("window IPC methods", () => {
  it.effect("decodes and delegates the atomic remote SSH URL action", () => {
    const inputs: unknown[] = [];
    const service = DesktopSshEnvironment.DesktopSshEnvironment.of({
      openRemoteUrl: (input) =>
        Effect.sync(() => {
          inputs.push(input);
          return {
            opened: true,
            kind: "direct-forward",
            remotePort: 5173,
            localPort: 43_001,
          } as const;
        }),
    } as DesktopSshEnvironment.DesktopSshEnvironmentShape);
    const input = {
      target: {
        alias: "devbox",
        hostname: "devbox.example.com",
        username: "julius",
        port: 2222,
      },
      url: "http://localhost:5173/path?q=1#x",
    };

    return Effect.gen(function* () {
      const result = yield* openRemoteSshUrl.handler(input);

      assert.deepEqual(inputs, [input]);
      assert.deepEqual(result, {
        opened: true,
        kind: "direct-forward",
        remotePort: 5173,
        localPort: 43_001,
      });
    }).pipe(Effect.provide(Layer.succeed(DesktopSshEnvironment.DesktopSshEnvironment, service)));
  });
});
