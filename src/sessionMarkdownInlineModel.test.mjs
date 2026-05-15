import assert from "node:assert/strict";
import { parseInlineTokens } from "./sessionMarkdownInlineModel.js";

assert.deepEqual(parseInlineTokens(""), []);
assert.deepEqual(parseInlineTokens("plain"), [{ type: "text", text: "plain" }]);
assert.deepEqual(parseInlineTokens("**bold** `code`").map((token) => token.type), ["bold", "text", "code"]);

const safeLink = parseInlineTokens("[docs](https://example.com)");
assert.deepEqual(safeLink, [{ type: "link", text: "docs", href: "https://example.com" }]);

const mailLink = parseInlineTokens("[mail](mailto:test@example.com)");
assert.equal(mailLink[0].type, "link");
assert.equal(mailLink[0].href, "mailto:test@example.com");

const anchorLink = parseInlineTokens("[section](#part)");
assert.equal(anchorLink[0].type, "link");
assert.equal(anchorLink[0].href, "#part");

assert.deepEqual(parseInlineTokens("[bad](javascript:alert(1))"), [
  { type: "text", text: "[bad](javascript:alert(1)" },
  { type: "text", text: ")" }
]);
assert.deepEqual(parseInlineTokens("[file](file:///C:/secret.txt)"), [
  { type: "text", text: "[file](file:///C:/secret.txt)" }
]);
assert.deepEqual(parseInlineTokens("[relative](./local.md)"), [
  { type: "text", text: "[relative](./local.md)" }
]);

console.log("session markdown inline model ok");
