const PROTECTED_LAUNCHERS = Object.freeze([
  Object.freeze({
    matches: (value) => value === "airclaude",
    name: "airclaude",
    lanes: ["managed"],
    hopChain: ["airclaude", "shield", "managed"],
  }),
  Object.freeze({
    matches: (value) => /^cclaude-[a-z0-9][a-z0-9._-]*$/i.test(value),
    name: "cclaude-*",
    lanes: ["managed"],
    hopChain: ["cclaude-*", "airclaude", "shield", "managed"],
  }),
  Object.freeze({
    matches: (value) => value === "hr-airclaude",
    name: "hr-airclaude",
    lanes: ["managed"],
    hopChain: ["headroom", "airclaude", "shield", "managed"],
  }),
  Object.freeze({
    matches: (value) => value === "hr-claude-web",
    name: "hr-claude-web",
    lanes: ["managed"],
    hopChain: ["headroom", "web", "shield", "managed"],
  }),
  Object.freeze({
    matches: (value) => value === "hr-claude-sub",
    name: "hr-claude-sub",
    lanes: ["subscription"],
    hopChain: ["headroom", "subscription", "shield", "subscription"],
  }),
]);

const DECLARED_BYPASSES = Object.freeze({
  claude: "direct_client",
  "command-claude": "direct_client",
});

export function resolveShieldLauncher({ launcher, mode, headroom = false, providerOverride } = {}) {
  if (typeof launcher !== "string" || launcher.length === 0 || launcher.length > 128) {
    throw new TypeError("shield launcher is required");
  }
  if (mode !== undefined && (typeof mode !== "string" || mode.length === 0 || mode.length > 64)) {
    throw new TypeError("shield launcher mode is invalid");
  }
  if (typeof headroom !== "boolean") throw new TypeError("shield launcher Headroom state is invalid");
  if (Object.hasOwn(DECLARED_BYPASSES, launcher)) {
    return Object.freeze({ coverage: "bypass", bypassReason: DECLARED_BYPASSES[launcher] });
  }
  const descriptor = PROTECTED_LAUNCHERS.find((candidate) => candidate.matches(launcher));
  if (!descriptor) throw new Error(`undeclared Shield launcher: ${launcher}`);
  const isHeadroom = descriptor.name.startsWith("hr-");
  if (headroom !== isHeadroom) throw new Error(`shield launcher Headroom disposition mismatch: ${launcher}`);
  const lane = providerOverride ?? descriptor.lanes[0];
  if (!descriptor.lanes.includes(lane)) throw new Error(`shield launcher lane is not allowed: ${launcher}`);
  const hopChain = [...descriptor.hopChain];
  if (hopChain.at(-1) !== lane) throw new Error(`shield launcher descriptor is invalid: ${launcher}`);
  return Object.freeze({ coverage: "protected", clientLane: lane, destinationClass: lane, hopChain });
}

export function shieldLauncherDescriptors() {
  return Object.freeze(PROTECTED_LAUNCHERS.map(({ name, lanes, hopChain }) => Object.freeze({
    coverage: "protected", launcher: name, lanes: [...lanes], hopChain: [...hopChain],
  })));
}
