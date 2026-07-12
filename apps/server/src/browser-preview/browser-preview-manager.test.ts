import { describe, expect, it } from "vitest";

import { parse_localhost_dev_ports } from "./browser-preview-manager.ts";

describe("parse_localhost_dev_ports", () => {
  it("prefers the chat port and ignores the GITS server", () => {
    expect(
      parse_localhost_dev_ports(
        'LISTEN 0 511 127.0.0.1:13773 0.0.0.0:* users:(("node",pid=1))\nLISTEN 0 511 *:8080 *:* users:(("node",pid=2))\nLISTEN 0 511 *:39369 *:* users:(("bun",pid=3))',
        39_369,
      ),
    ).toEqual([39_369, 8080]);
  });
});
