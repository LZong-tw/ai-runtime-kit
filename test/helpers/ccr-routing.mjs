// A model of CCR 3.0.18's gateway route decision (gPe in dist/main/cli.js),
// limited to the condition rules AirKit writes. The request's CCR profile comes
// from the gateway key it presented: the gateway sets x-auth-api-key-id to the
// key's id, `profile:<profile id>`, and the matching enabled profile's
// routing.rules run before the global Router.rules. The first enabled rule
// whose condition matches decides; no match leaves the model as sent.
export function resolveCcrRoute(config, { model, profileId = null }) {
  const profiles = config.profile?.enabled === false ? [] : config.profile?.profiles ?? [];
  const profile = profileId === null
    ? undefined
    : profiles.find((candidate) => candidate.enabled !== false && candidate.id === profileId);
  const profileRules = profile && profile.routing && profile.routing.enabled !== false
    ? profile.routing.rules ?? []
    : [];
  for (const rule of [...profileRules, ...(config.Router?.rules ?? [])]) {
    if (rule.enabled === false || !rule.condition) continue;
    if (!conditionMatches(rule.condition, model)) continue;
    const rewrites = rule.rewrites ?? (rule.rewrite ? [rule.rewrite] : []);
    const set = rewrites.find(({ key, operation }) => key === "request.body.model" && operation === "set");
    return { model: set?.value ?? rule.target ?? model, ruleId: rule.id };
  }
  return { model, ruleId: null };
}

function conditionMatches({ left, operator, right }, model) {
  if (left !== "request.body.model") return false;
  if (operator === "starts-with") return model.startsWith(right);
  if (operator === "==") return model === right;
  throw new Error(`routing model does not cover operator ${operator}`);
}
