const TOOL_LABEL_LIMIT = 72;
const PROCESS_FILTERS = ["all", "note", "thinking", "tool", "subagent", "error"];

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function itemTime(item, key) {
  return item?.[key] || item?.[key.replace(/At$/, "_at")] || "";
}

function durationMs(startedAt, endedAt) {
  const start = Date.parse(startedAt || "");
  const end = Date.parse(endedAt || "");
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return end - start;
}

export function processItemType(item) {
  if (!item || typeof item !== "object") return "";
  if (item.type === "note") return "note";
  if (item.type === "thinking") return "thinking";
  if (item.type === "command") return isSubagentTool(item) ? "subagent" : "tool";
  if (item.type === "progress") return "system";
  if (item.type === "error") return "error";
  return "";
}

export function isSubagentTool(item) {
  const value = `${item?.toolName || ""} ${item?.command || ""}`.toLowerCase();
  return /\b(subagent|run_subagent|agent)\b/.test(value);
}

export function commandDisplayLabel(item) {
  const toolName = String(item?.toolName || "").trim();
  const command = String(item?.command || "").trim();
  const label = command || toolName || "tool";
  if (label.length <= TOOL_LABEL_LIMIT) return label;
  return `${label.slice(0, TOOL_LABEL_LIMIT)}…`;
}

export function commandToolIcon(item) {
  const toolName = String(item?.toolName || "").toLowerCase();
  const command = String(item?.command || "").trim().split(/\s+/)[0].toLowerCase();
  const value = toolName || command;
  if (isSubagentTool(item)) return "agent";
  if (["read", "cat", "grep", "rg", "find", "ls"].includes(value)) return "read";
  if (["write", "edit", "cp", "mv", "mkdir", "touch"].includes(value)) return "write";
  if (["npm", "node", "python", "cargo", "go", "rustc", "bash", "powershell", "cmd"].includes(value)) return "run";
  if (value === "git") return "git";
  return "tool";
}

function shouldKeepProgress(item, hasThinking, toolIds) {
  const key = String(item?.key || item?.id || "");
  if (hasThinking && key === "progress-thinking") return false;
  if (key === "progress-output") return false;
  if (key.startsWith("progress-tool-")) {
    const toolId = key.replace(/^progress-tool-/, "");
    return !toolIds.has(toolId);
  }
  return true;
}

function toThinkingStep(item, index) {
  return {
    id: item.id || `thinking-${index}`,
    kind: "thinking",
    round: Number.isInteger(item.round) ? item.round : index + 1,
    title: item.title || `思考过程 ${index + 1}`,
    status: item.roundClosed ? "completed" : (item.status || "completed"),
    text: String(item.text || ""),
    startedAt: itemTime(item, "createdAt"),
    endedAt: itemTime(item, "updatedAt"),
    durationMs: durationMs(itemTime(item, "createdAt"), itemTime(item, "updatedAt"))
  };
}

function toNoteStep(item, index) {
  return {
    id: item.id || `note-${index}`,
    kind: "note",
    title: String(item.title || "操作说明"),
    text: String(item.text || item.detail || ""),
    status: item.status || "completed",
    startedAt: itemTime(item, "createdAt"),
    endedAt: itemTime(item, "updatedAt"),
    durationMs: durationMs(itemTime(item, "createdAt"), itemTime(item, "updatedAt"))
  };
}

function toToolStep(item, index) {
  const toolCallId = String(item.toolCallId || item.id || "").replace(/^command-/, "");
  return {
    id: item.id || `tool-${index}`,
    kind: isSubagentTool(item) ? "subagent" : "tool",
    toolCallId,
    toolName: String(item.toolName || ""),
    command: String(item.command || ""),
    args: item.args && typeof item.args === "object" ? item.args : {},
    title: commandDisplayLabel(item),
    status: item.status || "completed",
    output: String(item.output || ""),
    exitCode: item.exitCode ?? null,
    isError: item.status === "failed" || (item.exitCode != null && item.exitCode !== 0),
    startedAt: itemTime(item, "createdAt"),
    endedAt: itemTime(item, "updatedAt"),
    durationMs: durationMs(itemTime(item, "createdAt"), itemTime(item, "updatedAt"))
  };
}

function toSystemStep(item, index) {
  return {
    id: item.id || `system-${index}`,
    kind: "system",
    title: String(item.title || "处理过程"),
    detail: String(item.detail || ""),
    status: item.status || "completed",
    startedAt: itemTime(item, "createdAt"),
    endedAt: itemTime(item, "updatedAt"),
    durationMs: durationMs(itemTime(item, "createdAt"), itemTime(item, "updatedAt"))
  };
}

function toErrorStep(item, index) {
  return {
    id: item.id || `error-${index}`,
    kind: "error",
    title: String(item.title || "执行失败"),
    detail: String(item.detail || item.text || ""),
    status: "failed",
    startedAt: itemTime(item, "createdAt"),
    endedAt: itemTime(item, "updatedAt"),
    durationMs: durationMs(itemTime(item, "createdAt"), itemTime(item, "updatedAt"))
  };
}

export function buildProcessView(items, turnStatus = "completed") {
  const input = safeArray(items);
  const toolIds = new Set(input
    .filter((item) => item?.type === "command")
    .map((item) => String(item.toolCallId || item.id || "").replace(/^command-/, ""))
    .filter(Boolean));
  const hasThinking = input.some((item) => item?.type === "thinking");
  const steps = [];

  input.forEach((item, index) => {
    const kind = processItemType(item);
    if (kind === "note") steps.push(toNoteStep(item, index));
    else if (kind === "thinking") steps.push(toThinkingStep(item, index));
    else if (kind === "tool" || kind === "subagent") steps.push(toToolStep(item, index));
    else if (kind === "system" && shouldKeepProgress(item, hasThinking, toolIds)) steps.push(toSystemStep(item, index));
    else if (kind === "error") steps.push(toErrorStep(item, index));
  });

  const noteCount = steps.filter((step) => step.kind === "note").length;
  const thinkingCount = steps.filter((step) => step.kind === "thinking").length;
  const toolCount = steps.filter((step) => step.kind === "tool").length;
  const subagentCount = steps.filter((step) => step.kind === "subagent").length;
  const failedCount = steps.filter((step) => step.status === "failed" || step.isError).length;

  return {
    status: turnStatus || "completed",
    steps,
    counts: {
      note: noteCount,
      thinking: thinkingCount,
      tool: toolCount,
      subagent: subagentCount,
      failed: failedCount,
      total: steps.length
    }
  };
}

export function processSummaryText(view) {
  const counts = view?.counts || {};
  const parts = [];
  if (counts.note) parts.push(`${counts.note} 条说明`);
  if (counts.thinking) parts.push(`${counts.thinking} 轮思考`);
  if (counts.tool) parts.push(`${counts.tool} 个工具`);
  if (counts.subagent) parts.push(`${counts.subagent} 个子代理`);
  if (counts.failed) parts.push(`${counts.failed} 个失败`);
  return parts.join(" · ") || "处理过程";
}

export function normalizeProcessFilter(filter) {
  return PROCESS_FILTERS.includes(filter) ? filter : "all";
}

export function filterProcessSteps(steps, filter) {
  const mode = normalizeProcessFilter(filter);
  const input = safeArray(steps);
  if (mode === "all") return input;
  if (mode === "tool") return input.filter((step) => step?.kind === "tool" || step?.kind === "subagent");
  if (mode === "error") return input.filter((step) => step?.kind === "error" || step?.status === "failed" || step?.isError);
  return input.filter((step) => step?.kind === mode);
}

export function processFilterOptions(view) {
  const counts = view?.counts || {};
  return [
    { id: "all", label: "全部", count: counts.total || 0 },
    { id: "note", label: "说明", count: counts.note || 0 },
    { id: "thinking", label: "思考", count: counts.thinking || 0 },
    { id: "tool", label: "工具", count: (counts.tool || 0) + (counts.subagent || 0) },
    { id: "subagent", label: "子代理", count: counts.subagent || 0 },
    { id: "error", label: "错误", count: counts.failed || 0 }
  ].filter((option) => option.id === "all" || option.count > 0);
}

export function shouldAutoExpandProcessStep(step, isTurnRunning = false) {
  if (!step) return false;
  if (step.kind === "note") return true;
  if (step.status === "failed" || step.isError) return true;
  return Boolean(isTurnRunning && step.status === "running");
}
