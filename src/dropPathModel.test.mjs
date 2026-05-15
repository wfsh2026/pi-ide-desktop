import assert from "node:assert/strict";
import { isLikelyFilePath, pathFromDroppedText } from "./dropPathModel.js";

assert.equal(pathFromDroppedText('"C:\\repo\\src\\App.jsx"'), "C:\\repo\\src\\App.jsx");
assert.equal(pathFromDroppedText("C:\\repo\\src\\App.jsx"), "C:\\repo\\src\\App.jsx");
assert.equal(pathFromDroppedText("file:///C:/repo/src/App.jsx"), "C:\\repo\\src\\App.jsx");
assert.equal(pathFromDroppedText("file:///C:/repo/%E6%96%87%E4%BB%B6.txt"), "C:\\repo\\文件.txt");
assert.equal(pathFromDroppedText("# comment\nfile:///C:/repo/src/App.jsx"), "C:\\repo\\src\\App.jsx");

assert.equal(isLikelyFilePath("C:\\repo\\src\\App.jsx"), true);
assert.equal(isLikelyFilePath("./src/App.jsx"), true);
assert.equal(isLikelyFilePath("普通文本"), false);

console.log("drop path model ok");
