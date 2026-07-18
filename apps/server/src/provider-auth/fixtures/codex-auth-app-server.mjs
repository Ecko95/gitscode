import { appendFileSync } from "node:fs";

const logPath = process.env["FAKE_CODEX_AUTH_LOG"];
const mode = process.env["FAKE_CODEX_AUTH_MODE"] ?? "pending";
const loginId = "fake-login-id";

const log = (entry) => {
  if (logPath) appendFileSync(logPath, `${JSON.stringify(entry)}\n`, "utf8");
};

const write = (message) => {
  process.stdout.write(`${JSON.stringify(message)}\n`);
};

const respond = (id, result) => write({ id, result });

const handle = (message) => {
  const method = message["method"];
  const id = message["id"];
  if (typeof method !== "string") return;
  log({ method, params: message["params"], codexHome: process.env["CODEX_HOME"] });

  if (method === "initialized") return;
  if (typeof id !== "string" && typeof id !== "number") return;

  switch (method) {
    case "initialize":
      respond(id, {
        userAgent: "fake-codex-auth-server",
        codexHome: process.env["CODEX_HOME"] ?? process.cwd(),
        platformFamily: "unix",
        platformOs: process.platform,
      });
      return;
    case "account/login/start":
      respond(id, {
        type: "chatgptDeviceCode",
        loginId,
        userCode: "ABCD-EFGH",
        verificationUrl: "https://auth.example.test/device",
      });
      if (mode !== "pending") {
        queueMicrotask(() =>
          write({
            method: "account/login/completed",
            params: { loginId, success: mode === "success" },
          }),
        );
      }
      return;
    case "account/login/cancel":
      respond(id, { status: "canceled" });
      return;
    case "account/logout":
      respond(id, {});
      return;
    default:
      write({ id, error: { code: -32601, message: `Unhandled request: ${method}` } });
  }
};

let remainder = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  remainder += chunk;
  const lines = remainder.split("\n");
  remainder = lines.pop() ?? "";
  for (const line of lines) {
    if (line.trim()) handle(JSON.parse(line));
  }
});
