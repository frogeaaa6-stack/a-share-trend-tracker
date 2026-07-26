import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { createFeishuSignature } from "../lib/notifications/feishuSignature.ts";

test("creates the Feishu custom-bot HMAC signature", async () => {
  const timestamp = "1721880000";
  const secret = "test-signing-secret";
  const expected = createHmac("sha256", `${timestamp}\n${secret}`).digest("base64");
  assert.equal(await createFeishuSignature(timestamp, secret), expected);
});
