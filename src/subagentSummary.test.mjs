import assert from "node:assert/strict";
import { collectSessionSubagents, sessionSubagentSummary } from "./subagentSummary.js";

assert.equal(sessionSubagentSummary(null), null);
assert.equal(sessionSubagentSummary({ turns: [] }), null);
assert.equal(sessionSubagentSummary({
  turns: [
    {
      items: [
        { type: "assistant_message", text: "ok" },
        { type: "subagent_group", runs: [{ status: "completed" }, { status: "completed" }] }
      ]
    }
  ]
}), "子 Agent 2 个");
assert.equal(sessionSubagentSummary({
  turns: [{ items: [{ type: "subagent_group", runs: [{ status: "completed" }, { status: "running" }] }] }]
}), "子 Agent 2 个 · 1 运行中");
assert.equal(sessionSubagentSummary({
  turns: [{ items: [{ type: "subagent_group", runs: [{ status: "failed" }] }] }]
}), "子 Agent 1 个 · 1 失败");
assert.equal(sessionSubagentSummary({
  turns: [{ items: [{ type: "subagent_group", runs: [{ status: "defined" }] }] }]
}), "子 Agent 1 个 · 已定义");

const subagents = collectSessionSubagents({
  turns: [{
    items: [{
      type: "subagent_group",
      runs: [{
        id: "reviewer-1",
        agent_name: "reviewer",
        task: "review diff",
        status: "completed",
        session_file: "C:\\repo\\.pi\\agent\\sessions\\child.jsonl",
        items: [
          { type: "file_reference", files: [{ path: "C:\\repo\\src\\App.jsx", source: "pi-tool-read" }] },
          { type: "file_output", files: [{ path: "C:\\repo\\review.md", source: "pi-write" }] }
        ],
        files: [{ path: "C:\\repo\\.pi\\agent\\sessions\\child.jsonl", source: "subagent-artifact" }]
      }]
    }]
  }]
});

assert.equal(subagents.length, 1);
assert.equal(subagents[0].name, "reviewer");
assert.equal(subagents[0].task, "review diff");
assert.equal(subagents[0].referencedFiles[0].name, "App.jsx");
assert.equal(subagents[0].outputFiles[0].name, "review.md");
assert.equal(subagents[0].outputFiles[1].name, "child.jsonl");
