import assert from "node:assert/strict";
import { DEFAULT_STORAGE_LIMITS, limitTextValue, normalizeStoredProjects, positiveInteger, resolveStoredActiveSession } from "./projectStorageModel.js";

assert.equal(positiveInteger("20", 5), 20);
assert.equal(positiveInteger("-1", 5), 5);
assert.equal(positiveInteger("bad", 5), 5);
assert.equal(DEFAULT_STORAGE_LIMITS.sessionTurnLimit <= 100, true);

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
      { id: "t2", status: "running", items: [
        { type: "assistant_message", text: "second-long", status: "running", text_blocks: { main: "second-long" } },
        { type: "progress", title: "运行中", status: "running" }
      ] }
    ],
    referenced_files: [{ path: "a" }, { path: "b" }],
    output_files: [{ path: "c" }, { path: "d" }],
    attachments: [{ path: "e" }, { path: "f" }]
  }]
}], {
  terminalPreviewChars: 4,
  sessionTextPreviewChars: 6,
  sessionTurnLimit: 1,
  sessionFileRecordLimit: 1,
  closeRunningTurns: true
});

const session = projects[0].sessions[0];
assert.equal(session.output, "6789");
assert.equal(session.output_truncated, true);
assert.equal(session.turns.length, 1);
assert.equal(session.turns_truncated, true);
assert.equal(session.turns[0].status, "completed");
assert.equal(session.turns[0].items[0].text, "d-long");
assert.equal(session.turns[0].items[0].text_truncated, true);
assert.equal(session.turns[0].items[0].status, "completed");
assert.equal(session.turns[0].items[0].text_blocks, undefined);
assert.equal(session.turns[0].items[1].status, "completed");
assert.deepEqual(session.referenced_files, [{ path: "b" }]);
assert.deepEqual(session.output_files, [{ path: "d" }]);
assert.deepEqual(session.attachments, [{ path: "f" }]);

const sessionLimited = normalizeStoredProjects([{
  id: "p2",
  sessions: [{ id: "a" }, { id: "b" }, { id: "c" }]
}], { projectSessionLimit: 2 });
assert.deepEqual(sessionLimited[0].sessions.map((item) => item.id), ["b", "c"]);

assert.deepEqual(resolveStoredActiveSession(sessionLimited, "p2", "c"), { projectId: "p2", sessionId: "c" });
assert.deepEqual(resolveStoredActiveSession(sessionLimited, "p2", "missing"), { projectId: "p2", sessionId: "c" });
assert.deepEqual(resolveStoredActiveSession([{ id: "p3", sessions: [{ id: "a", archived: true }] }], "p3", "missing"), { projectId: null, sessionId: null });
assert.deepEqual(resolveStoredActiveSession(sessionLimited, "missing", "c"), { projectId: null, sessionId: null });

console.log("project storage model ok");
