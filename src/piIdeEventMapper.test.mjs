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
  contentIndex: 1,
  delta: "，我在",
  blockText: "会话窗口正常，我在。"
}, { now: "2026-05-12T00:00:01.250Z", makeId });

assert.equal(turns[0].items.find((item) => item.type === "assistant_message").text, "会话窗口正常，我在。");

turns = applyPiIdeTimelineEvent(turns, {
  kind: "timeline",
  eventType: "message_update",
  deltaType: "text_delta",
  delta: "\nThe user is simply testing table output rendering, and I should keep this concise."
}, { now: "2026-05-12T00:00:01.500Z", makeId });

assert.equal(turns[0].items.find((item) => item.type === "assistant_message").text, "会话窗口正常，我在。");
assert.equal(
  turns[0].items.find((item) => item.type === "thinking").text.includes("The user is simply testing"),
  true
);

turns = applyPiIdeTimelineEvent(turns, {
  kind: "timeline",
  eventType: "message_end",
  messageRole: "assistant",
  text: `The user is asking me to test table output again. I should keep this concise.

已在上面的回复中展示了多种表格样式。你目前看到的效果如何？如果需要调整，请告诉我具体需求，例如：

- 是否表格渲染不正确，需要调整格式？
- 需要特定的列对齐方式？
- 需要嵌套或更复杂的表格？`
}, { now: "2026-05-12T00:00:01.750Z", makeId });

assert.equal(
  turns[0].items.find((item) => item.type === "assistant_message").text,
  `已在上面的回复中展示了多种表格样式。你目前看到的效果如何？如果需要调整，请告诉我具体需求，例如：

- 是否表格渲染不正确，需要调整格式？
- 需要特定的列对齐方式？
- 需要嵌套或更复杂的表格？`
);
assert.equal(
  turns[0].items.find((item) => item.type === "thinking").text.includes("The user is asking me to test table output again"),
  true
);

turns = applyPiIdeTimelineEvent(turns, {
  kind: "timeline",
  eventType: "message_update",
  deltaType: "text_delta",
  delta: "\n表格行列合法状态\n- **格式** 数值数据"
}, { now: "2026-05-12T00:00:01.800Z", makeId });

assert.equal(
  turns[0].items.find((item) => item.type === "assistant_message").text.includes("表格行列合法状态"),
  true
);

let blockTurns = applyPiIdeTimelineEvent(baseTurns, {
  kind: "timeline",
  eventType: "message_update",
  deltaType: "text_delta",
  contentIndex: 1,
  delta: "| 项目",
  blockText: "| 项目 | 数值 |\n| --- | --- |\n| 收入 | 120,000 |"
}, { now: "2026-05-12T00:00:01.850Z", makeId });

blockTurns = applyPiIdeTimelineEvent(blockTurns, {
  kind: "timeline",
  eventType: "message_update",
  deltaType: "text_delta",
  contentIndex: 1,
  delta: "重新",
  blockText: "| 项目 | 数值 |\n| --- | --- |\n| 收入 | 120,000 |\n| 成本 | 80,000 |"
}, { now: "2026-05-12T00:00:01.860Z", makeId });

assert.equal(
  blockTurns[0].items.find((item) => item.type === "assistant_message").text,
  "| 项目 | 数值 |\n| --- | --- |\n| 收入 | 120,000 |\n| 成本 | 80,000 |"
);

turns = applyPiIdeTimelineEvent(turns, {
  kind: "timeline",
  eventType: "message_update",
  deltaType: "text_end",
  content: `The user wants a final correction.

这是 text_end 提供的完整最终回答。`
}, { now: "2026-05-12T00:00:01.900Z", makeId });

assert.equal(
  turns[0].items.find((item) => item.type === "assistant_message").text,
  "这是 text_end 提供的完整最终回答。"
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

turns = applyPiIdeTimelineEvent(turns, {
  kind: "subagent",
  eventType: "subagent_start",
  runId: "reviewer-1",
  agentName: "reviewer",
  task: "review current diff",
  model: { id: "gpt-5.5", provider: "openai" }
}, { now: "2026-05-12T00:00:03.200Z", makeId });

turns = applyPiIdeTimelineEvent(turns, {
  kind: "subagent",
  eventType: "subagent_end",
  runId: "reviewer-1",
  agentName: "reviewer",
  summary: "No blocking issues.",
  status: "completed",
  artifactPaths: ["C:\\repo\\.pi\\agent\\sessions\\child.jsonl"]
}, { now: "2026-05-12T00:00:03.600Z", makeId });

const subagentGroup = turns[0].items.find((item) => item.type === "subagent_group");
assert.equal(subagentGroup.runs.length, 1);
assert.equal(subagentGroup.runs[0].agent_name, "reviewer");
assert.equal(subagentGroup.runs[0].task, "review current diff");
assert.equal(subagentGroup.runs[0].status, "completed");
assert.equal(subagentGroup.runs[0].summary, "No blocking issues.");
assert.equal(subagentGroup.runs[0].files[0].name, "child.jsonl");

let definitionTurns = applyPiIdeTimelineEvent(baseTurns, {
  kind: "timeline",
  eventType: "tool_execution_start",
  toolCallId: "call-agent-write",
  toolName: "write",
  args: { path: "C:\\repo\\.pi\\agents\\modify-number.md" }
}, { now: "2026-05-12T00:00:03.700Z", makeId });

const definitionGroup = definitionTurns[0].items.find((item) => item.type === "subagent_group");
assert.equal(definitionGroup.runs.length, 1);
assert.equal(definitionGroup.runs[0].agent_name, "modify-number");
assert.equal(definitionGroup.runs[0].status, "defined");
assert.equal(definitionGroup.runs[0].files[0].source, "subagent-definition");

let intercomTurns = applyPiIdeTimelineEvent(baseTurns, {
  kind: "timeline",
  eventType: "tool_execution_start",
  toolCallId: "call-intercom",
  toolName: "intercom",
  args: { target: "subagent-chat-1", message: "inspect project" }
}, { now: "2026-05-12T00:00:03.800Z", makeId });

intercomTurns = applyPiIdeTimelineEvent(intercomTurns, {
  kind: "timeline",
  eventType: "tool_execution_end",
  toolCallId: "call-intercom",
  toolName: "intercom",
  args: { target: "subagent-chat-1", message: "inspect project" },
  result: { content: [{ type: "text", text: "Reply from subagent-chat-1: done" }] },
  isError: false
}, { now: "2026-05-12T00:00:04.000Z", makeId });

const intercomGroup = intercomTurns[0].items.find((item) => item.type === "subagent_group");
assert.equal(intercomGroup.runs.length, 1);
assert.equal(intercomGroup.runs[0].agent_name, "subagent-chat-1");
assert.equal(intercomGroup.runs[0].task, "inspect project");
assert.equal(intercomGroup.runs[0].status, "completed");
assert.equal(intercomGroup.runs[0].summary, "Reply from subagent-chat-1: done");

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
