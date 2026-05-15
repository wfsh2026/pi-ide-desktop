function safeLinkHref(href) {
  const value = String(href || "").trim();
  if (!value || /[\u0000-\u001f\u007f]/.test(value)) return "";
  if (value.startsWith("#")) return value;

  try {
    const url = new URL(value);
    return ["http:", "https:", "mailto:"].includes(url.protocol) ? value : "";
  } catch (_) {
    return "";
  }
}

export function parseInlineTokens(text) {
  const value = String(text || "");
  if (!value) return [];
  const tokenPattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|(__[^_]+__)|(\*[^*]+\*)|(_[^_]+_)|(~~[^~]+~~)|(\[[^\]]+\]\([^)]+\))/g;
  const tokens = [];
  let lastIndex = 0;
  let match;

  while ((match = tokenPattern.exec(value)) !== null) {
    if (match.index > lastIndex) tokens.push({ type: "text", text: value.slice(lastIndex, match.index) });
    const raw = match[0];
    if (raw.startsWith("`") && raw.endsWith("`")) {
      tokens.push({ type: "code", text: raw.slice(1, -1) });
    } else if ((raw.startsWith("**") && raw.endsWith("**")) || (raw.startsWith("__") && raw.endsWith("__"))) {
      tokens.push({ type: "bold", text: raw.slice(2, -2) });
    } else if (raw.startsWith("~~") && raw.endsWith("~~")) {
      tokens.push({ type: "strikethrough", text: raw.slice(2, -2) });
    } else if (raw.startsWith("*") && raw.endsWith("*")) {
      tokens.push({ type: "italic", text: raw.slice(1, -1) });
    } else if (raw.startsWith("_") && raw.endsWith("_")) {
      tokens.push({ type: "italic", text: raw.slice(1, -1) });
    } else if (raw.startsWith("[")) {
      const linkMatch = raw.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      const href = linkMatch ? safeLinkHref(linkMatch[2]) : "";
      tokens.push(href ? { type: "link", text: linkMatch[1], href } : { type: "text", text: raw });
    }
    lastIndex = tokenPattern.lastIndex;
  }

  if (lastIndex < value.length) tokens.push({ type: "text", text: value.slice(lastIndex) });
  return tokens;
}
