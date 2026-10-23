import type { TestContext } from "node:test";

export function stubResend(t: TestContext) {
  const env = process.env as Record<string, string | undefined>;
  const savedKey = env.RESEND_API_KEY;
  env.RESEND_API_KEY = "re_test";
  t.after(() => {
    if (savedKey === undefined) delete env.RESEND_API_KEY;
    else env.RESEND_API_KEY = savedKey;
  });

  let reply = { status: 200, body: {} as Record<string, string> };
  const fetch = t.mock.method(globalThis, "fetch", async () =>
    new Response(JSON.stringify(reply.body), { status: reply.status }),
  );
  const errors = t.mock.method(console, "error", () => {});

  return {
    answer(status: number, name?: string) {
      reply = { status, body: name ? { name } : {} };
    },
    get attempts() {
      return fetch.mock.callCount();
    },
    get logged() {
      return errors.mock.calls.map((call) => call.arguments[0]);
    },
  };
}
