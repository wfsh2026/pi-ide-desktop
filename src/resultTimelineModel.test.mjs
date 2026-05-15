import assert from "node:assert/strict";
import { buildResultView, resultStatusLabel, verificationSummary } from "./resultTimelineModel.js";

const empty = buildResultView();
assert.equal(empty.status, "unverified");
assert.equal(empty.hasContent, false);
assert.equal(resultStatusLabel(empty.status), "未验证");
assert.equal(verificationSummary(empty.verifications), "未运行验证");

const verified = buildResultView({
  conclusion: "完成",
  processItems: [
    { id: "cmd-1", type: "command", command: "npm run build", status: "completed", exitCode: 0 },
    { id: "cmd-2", type: "command", command: "node src/processTimelineModel.test.mjs", status: "completed", exitCode: 0 },
    { id: "cmd-3", type: "command", command: "rg --files", status: "completed", exitCode: 0 }
  ],
  outputs: [
    { name: "App.jsx", path: "src/App.jsx" },
    { name: "App.jsx", path: "src/App.jsx" },
    { name: "styles.css", path: "src/styles.css" }
  ]
}, "completed");

assert.equal(verified.status, "verified");
assert.equal(verified.conclusion, "完成");
assert.equal(verified.verifications.length, 2);
assert.equal(verified.files.length, 2);
assert.equal(verificationSummary(verified.verifications), "2 通过");
assert.equal(resultStatusLabel(verified.status), "已验证");

const failed = buildResultView({
  processItems: [
    { id: "cmd-1", type: "command", command: "cargo check", status: "failed", exitCode: 101 }
  ],
  errors: [{ id: "err", detail: "failed" }]
}, "failed");

assert.equal(failed.status, "failed");
assert.equal(failed.verifications[0].status, "failed");
assert.equal(verificationSummary(failed.verifications), "1 失败");
assert.equal(resultStatusLabel(failed.status), "失败");

const running = buildResultView({
  processItems: [
    { id: "cmd-1", type: "command", command: "pnpm test", status: "running" }
  ]
}, "running");

assert.equal(running.status, "running");
assert.equal(verificationSummary(running.verifications), "1 运行中");

console.log("result timeline model ok");
