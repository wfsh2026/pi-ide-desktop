export function parseTableCells(row) {
  return String(row || "").trim().replace(/^\|/, "").replace(/\|\s*$/, "").split("|").map((cell) => cell.trim());
}

export function isTableRow(line) {
  return String(line || "").includes("|") && parseTableCells(line).length >= 2;
}

export function isTableSeparator(line) {
  if (line == null) return false;
  const cells = parseTableCells(line);
  return cells.length >= 2 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s+/g, "")));
}

export function tableStartsAt(lines, index) {
  return isTableRow(lines?.[index]) && isTableSeparator(lines?.[index + 1]);
}
