import { readShieldOperationalStatus } from "./operational-status.mjs";

export async function readShieldStatuslineState(options = {}) {
  const operational = await (options.readOperationalStatus ?? readShieldOperationalStatus)(options);
  return shieldStatuslineState(operational);
}

export function shieldStatuslineState(operational) {
  const lanes = Array.isArray(operational?.lanes) ? operational.lanes : [];
  const state = ["protected", "blocked", "unavailable"].includes(operational?.state) ? operational.state : "unavailable";
  return Object.freeze({
    shield: state,
    lanes: Object.freeze(lanes.map((lane) => Object.freeze({
      lane: lane.lane,
      state: lane.state,
      approval: lane.state === "protected" ? "available" : "blocked",
    }))),
  });
}
