import assert from "node:assert/strict";
import { isTableSeparator, parseTableCells, tableStartsAt } from "./sessionMarkdownTableModel.js";

assert.deepEqual(parseTableCells(undefined), [""]);
assert.equal(isTableSeparator(undefined), false);
assert.equal(tableStartsAt(["只有一行 | 不是表格"], 0), false);
assert.equal(tableStartsAt(["| A | B |", "| --- | --- |"], 0), true);

console.log("session markdown table model ok");
