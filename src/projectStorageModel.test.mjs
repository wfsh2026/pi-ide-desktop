import assert from "node:assert/strict";
import { limitTextValue, normalizeStoredProjects, positiveInteger } from "./projectStorageModel.js";

assert.equal(positiveInteger("20", 5), 20);
assert.equal(positiveInteger("-1", 5), 5);
assert.equal(positiveInteger("bad", 5), 5);

assert.deepEqual(limitTextValue("abcdef", 3), { text: "def", truncated: true });
assert.deepEqual(limitTextValue("abc", 3), { text: "abc", truncated: false });

assert.deepEqual(normalizeStoredProjects(null), []);
assert.deepEqual(normalizeStoredProjects([{ id: "p1", sessions: "bad" }])[0].sessions, []);

const projects = normalizeStoredProjects([{
  id: "p1",
  sessions: [{
    id: "s1",
    output: "0123456789",
    turns: [
      { id: "t1", items: [{ type: "assistant_message", text: "first" }] },
      { id: "t2", items: [{ type: "assistant_message", text: "second-long" }] }
    ],
    referenced_files: [{ path: "a" }, { path: "b" }],
    output_files: [{ path: "c" }, { path: "d" }],
    attachments: [{ path: "e" }, { path: "f" }]
  }]
}], {
  terminalPreviewChars: 4,
  sessionTextPreviewChars: 6,
  sessionTurnLimit: 1,
  sessionFileRecordLimit: 1
});

const session = projects[0].sessions[0];
assert.equal(session.output, "6789");
assert.equal(session.output_truncated, true);
assert.equal(session.turns.length, 1);
assert.equal(session.turns_truncated, true);
assert.equal(session.turns[0].items[0].text, "d-long");
assert.equal(session.turns[0].items[0].text_truncated, true);
assert.deepEqual(session.referenced_files, [{ path: "b" }]);
assert.deepEqual(session.output_files, [{ path: "d" }]);
assert.deepEqual(session.attachments, [{ path: "f" }]);

console.log("project storage model ok");
