import assert from "node:assert/strict";
import { isComposerDropTarget, isPointerDragActive } from "./directoryDragModel.js";

assert.equal(isPointerDragActive(10, 10, 12, 12), false);
assert.equal(isPointerDragActive(10, 10, 16, 10), true);
assert.equal(isPointerDragActive(10, 10, 12, 12, "bad"), false);

assert.equal(isComposerDropTarget({ closest: (selector) => selector === ".composer" ? {} : null }), true);
assert.equal(isComposerDropTarget({ closest: () => null }), false);
assert.equal(isComposerDropTarget(null), false);

console.log("directory drag model ok");
