export function pathFromDroppedText(text) {
  let value = String(text || "").trim();
  if (!value) return "";
  value = value.split(/\r?\n/).find((line) => line.trim() && !line.trim().startsWith("#")) || value;
  value = value.trim();
  if (value.startsWith("file://")) {
    try {
      value = decodeURIComponent(value.replace(/^file:\/+/i, ""));
      if (/^[A-Za-z]\|/.test(value)) value = `${value[0]}:${value.slice(2)}`;
      if (/^[A-Za-z]:/.test(value)) return value.replaceAll("/", "\\");
      return value;
    } catch {
      return value.replace(/^file:\/+/i, "");
    }
  }
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1).replace(/\\"/g, '"').replace(/\\'/g, "'");
  }
  return value;
}

export function isLikelyFilePath(value) {
  const text = String(value || "").trim();
  return /^[A-Za-z]:[\\/]/.test(text)
    || text.startsWith("\\\\")
    || text.startsWith("/")
    || text.startsWith("./")
    || text.startsWith("../")
    || text.startsWith(".\\")
    || text.startsWith("..\\");
}
