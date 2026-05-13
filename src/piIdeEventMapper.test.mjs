import assert from "node:assert/strict";
import { applyPiIdeTimelineEvent } from "./piIdeEventMapper.js";

let id = 0;
const makeId = (prefix) => `${prefix}-${++id}`;

const baseTurns = [{
  id: "turn-1",
  status: "running",
  items: [
    { id: "user-1", type: "user_message", text: "测试会话窗口", status: "completed" },
    { id: "progress-1", type: "progress", title: "任务已发送给 Pi", status: "running" },
    { id: "assistant-1", type: "assistant_message", text: "", status: "running" }
  ]
}];

let turns = applyPiIdeTimelineEvent(baseTurns, {
  kind: "timeline",
  eventType: "message_end",
  messageRole: "user",
  text: "测试会话窗口"
}, { now: "2026-05-12T00:00:00.000Z", makeId });

assert.equal(turns[0].items.find((item) => item.type === "assistant_message").text, "");

turns = applyPiIdeTimelineEvent(turns, {
  kind: "timeline",
  eventType: "message_update",
  deltaType: "thinking_delta",
  delta: "正在判断用户意图。"
}, { now: "2026-05-12T00:00:00.000Z", makeId });

assert.equal(turns[0].items.find((item) => item.type === "thinking").text, "正在判断用户意图。");
assert.equal(turns[0].items.find((item) => item.type === "assistant_message").text, "");

turns = applyPiIdeTimelineEvent(turns, {
  kind: "timeline",
  eventType: "message_update",
  deltaType: "text_delta",
  delta: "会话窗口正常"
}, { now: "2026-05-12T00:00:01.000Z", makeId });

assert.equal(turns[0].items.find((item) => item.type === "assistant_message").text, "会话窗口正常");

turns = applyPiIdeTimelineEvent(turns, {
  kind: "timeline",
  eventType: "message_update",
  deltaType: "text_delta",
  delta: "\nThe user is simply testing table output rendering, and I should keep this concise."
}, { now: "2026-05-12T00:00:01.500Z", makeId });

assert.equal(turns[0].items.find((item) => item.type === "assistant_message").text, "会话窗口正常");
assert.equal(
  turns[0].items.find((item) => item.type === "thinking").text.includes("The user is simply testing"),
  true
);

turns = applyPiIdeTimelineEvent(turns, {
  kind: "timeline",
  eventType: "tool_execution_start",
  toolCallId: "call-1",
  toolName: "bash",
  args: { command: "rg --files" },
  cwd: "C:\\repo"
}, { now: "2026-05-12T00:00:02.000Z", makeId });

turns = applyPiIdeTimelineEvent(turns, {
  kind: "timeline",
  eventType: "tool_execution_end",
  toolCallId: "call-1",
  toolName: "bash",
  result: { content: [{ type: "text", text: "src/App.jsx" }], details: { exitCode: 0 } },
  isError: false
}, { now: "2026-05-12T00:00:03.000Z", makeId });

const command = turns[0].items.find((item) => item.type === "command");
assert.equal(command.command, "rg --files");
assert.equal(command.output, "src/App.jsx");
assert.equal(command.status, "completed");

const progressItems = turns[0].items.filter((item) => item.type === "progress");
assert.equal(progressItems.some((item) => item.title === "正在思考"), true);
assert.equal(progressItems.some((item) => item.title === "正在输出结果"), true);
assert.equal(progressItems.some((item) => item.title === "已运行 rg --files"), true);
assert.equal(progressItems.filter((item) => item.key === "progress-tool-call-1").length, 1);

turns = applyPiIdeTimelineEvent(turns, {
  kind: "timeline",
  eventType: "agent_end"
}, { now: "2026-05-12T00:00:04.000Z", makeId });

assert.equal(turns[0].status, "completed");
assert.equal(turns[0].items.find((item) => item.type === "assistant_message").status, "completed");

console.log("pi ide event mapper ok");
