import assert from "node:assert/strict";
import {
  buildProcessView,
  commandDisplayLabel,
  commandToolIcon,
  filterProcessSteps,
  normalizeProcessFilter,
  processFilterOptions,
  processSummaryText,
  shouldAutoExpandProcessStep
} from "./processTimelineModel.js";

assert.deepEqual(buildProcessView(null).steps, []);
assert.equal(processSummaryText(buildProcessView(null)), "处理过程");

const view = buildProcessView([
  { id: "progress-1", type: "progress", title: "AI 开始处理", status: "completed" },
  { id: "note-1", type: "note", title: "操作说明", text: "控制台 GBK 编码不支持 emoji，让我修复一下。", status: "completed" },
  { id: "thinking-1", type: "thinking", title: "思考过程 1", round: 1, text: "先读代码", roundClosed: true, status: "completed", created_at: "2026-05-12T00:00:00.000Z", updated_at: "2026-05-12T00:00:03.000Z" },
  { id: "progress-thinking", key: "progress-thinking", type: "progress", title: "正在思考", status: "completed" },
  { id: "command-call-1", type: "command", toolCallId: "call-1", toolName: "bash", command: "rg --files", output: "src/App.jsx", status: "completed", exitCode: 0 },
  { id: "progress-tool-call-1", key: "progress-tool-call-1", type: "progress", title: "已运行 rg --files", status: "completed" },
  { id: "command-call-2", type: "command", toolCallId: "call-2", toolName: "read", command: "read src/App.jsx", output: "content", status: "completed" },
  { id: "thinking-2", type: "thinking", title: "思考过程 2", round: 2, text: "再分析结果", status: "running" },
  { id: "command-call-3", type: "command", toolCallId: "call-3", toolName: "subagent", command: "subagent reviewer", status: "failed", exitCode: 1 },
  { id: "progress-output", key: "progress-output", type: "progress", title: "正在输出结果", status: "running" },
  { id: "noise", type: "unknown", title: "ignored" }
], "running");

assert.equal(view.status, "running");
assert.equal(view.counts.note, 1);
assert.equal(view.counts.thinking, 2);
assert.equal(view.counts.tool, 2);
assert.equal(view.counts.subagent, 1);
assert.equal(view.counts.failed, 1);
assert.equal(view.steps.some((step) => step.id === "progress-thinking"), false);
assert.equal(view.steps.some((step) => step.id === "progress-tool-call-1"), false);
assert.equal(view.steps.find((step) => step.id === "thinking-1").status, "completed");
assert.equal(view.steps.find((step) => step.id === "note-1").kind, "note");
assert.equal(view.steps.find((step) => step.id === "thinking-1").durationMs, 3000);
assert.equal(view.steps.find((step) => step.id === "thinking-2").status, "running");
assert.equal(view.steps.find((step) => step.id === "command-call-3").kind, "subagent");
assert.equal(processSummaryText(view), "1 条说明 · 2 轮思考 · 2 个工具 · 1 个子代理 · 1 个失败");
assert.equal(normalizeProcessFilter("bad"), "all");
assert.equal(filterProcessSteps(view.steps, "note").length, 1);
assert.equal(filterProcessSteps(view.steps, "thinking").length, 2);
assert.equal(filterProcessSteps(view.steps, "tool").length, 3);
assert.equal(filterProcessSteps(view.steps, "subagent").length, 1);
assert.equal(filterProcessSteps(view.steps, "error").length, 1);
assert.deepEqual(processFilterOptions(view).map((option) => option.id), ["all", "note", "thinking", "tool", "subagent", "error"]);
assert.equal(shouldAutoExpandProcessStep(view.steps.find((step) => step.id === "note-1"), false), true);
assert.equal(shouldAutoExpandProcessStep(view.steps.find((step) => step.id === "command-call-3"), false), true);
assert.equal(shouldAutoExpandProcessStep(view.steps.find((step) => step.id === "thinking-2"), true), true);
assert.equal(shouldAutoExpandProcessStep(view.steps.find((step) => step.id === "thinking-1"), false), false);

assert.equal(commandDisplayLabel({ command: "a".repeat(80) }), `${"a".repeat(72)}…`);
assert.equal(commandToolIcon({ toolName: "read", command: "read src/App.jsx" }), "read");
assert.equal(commandToolIcon({ toolName: "subagent", command: "subagent reviewer" }), "agent");

console.log("process timeline model ok");
