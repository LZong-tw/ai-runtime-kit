// Resolve the `provider/model` selector a Messages body carries to the CCR
// provider that will serve it. CCR's /model picker hex-encodes selectors as
// `claude-ccr-h<hex>`; decode that form too. Anything ambiguous resolves to
// null so callers leave the body alone rather than guess.
export function bindSelector(selector, providers) {
  if (typeof selector !== "string") return null;
  const encoded = /^(?:anthropic\/)?claude-ccr-h([0-9a-f]{2,4096})(?:\[1m\])?$/i.exec(selector);
  if (encoded) {
    if (encoded[1].length % 2 !== 0) return null;
    try {
      selector = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
        .decode(Buffer.from(encoded[1], "hex"));
    } catch { return null; }
  }
  const separator = selector.indexOf("/");
  if (separator < 1) return null;
  const name = selector.slice(0, separator);
  const model = selector.slice(separator + 1);
  const provider = (providers ?? []).find((entry) => entry.name === name);
  if (!provider?.models?.includes(model)) return null;
  return { provider, model };
}
