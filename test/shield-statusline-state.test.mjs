import assert from "node:assert/strict";
import test from "node:test";

import { readShieldStatuslineState, shieldStatuslineState } from "../src/shield/statusline-state.mjs";

test("Shield statusline state projects only neutral protection health", async () => {
  const state = await readShieldStatuslineState({
    readOperationalStatus: async () => ({
      state: "protected",
      lanes: [
        { lane: "managed", state: "protected", capability: "must-not-export", cost: 12 },
        { lane: "subscription", state: "unavailable", origin: "http://127.0.0.1:8811" },
      ],
    }),
  });
  assert.deepEqual(state, {
    shield: "protected",
    lanes: [
      { lane: "managed", state: "protected", approval: "available" },
      { lane: "subscription", state: "unavailable", approval: "blocked" },
    ],
  });
  assert.doesNotMatch(JSON.stringify(state), /capability|cost|127\.0\.0\.1/);
});

test("Shield statusline state fails closed for malformed operational data", () => {
  assert.deepEqual(shieldStatuslineState(null), { shield: "unavailable", lanes: [] });
});
