function latestTurnIndex(turns) {
  if (!Array.isArray(turns) || turns.length === 0) return -1;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    if (turns[index]?.status === "running") return index;
  }
  return turns.length - 1;
}

function resultText(result) {
  const content = Array.isArray(result?.content) ? result.content : [];
  return content.map((item) => {
    if (typeof item === "string") return item;
    if (item?.type === "text") return item.text || "";
    return "";
  }).filter(Boolean).join("\n");
}

function messageText(message) {
  const content = Array.isArray(message?.content) ? message.content : [];
  return content.map((item) => {
    if (typeof item === "string") return item;
    if (item?.type === "text") return item.text || "";
    return "";
  }).filter(Boolean).join("");
}

function looksLikeReasoningText(text) {
  const value = String(text || "").trim();
  if (!value) return false;
  const englishReasoningMarkers = [
    /^The user (?:is|wants|asked|provided|mentioned|needs)\b/i,
    /^User (?:is|wants|asked|provided|mentioned|needs)\b/i,
    /\bI should\b/i,
    /\bI need to\b/i,
    /\bI(?:'ll| will) (?:respond|answer|keep|provide|explain)\b/i,
    /\bLet's (?:keep|provide|answer|respond|craft)\b/i,
    /\bwhich translates to\b/i
  ];
  const chineseReasoningMarkers = [
    /^用户(?:只是|正在|想要|需要|要求|提供)/,
    /^我(?:应该|需要|会|将)/,
    /^这里(?:应该|需要|可以)/,
    /^看起来(?:像|是)/,
    /^表格行列合法状态/,
    /^[-*]\s*\*\*格式\*\*/
  ];
  return englishReasoningMarkers.some((pattern) => pattern.test(value))
    || chineseReasoningMarkers.some((pattern) => pattern.test(value));
}

function commandText(event) {
  if (event?.args?.command) return String(event.args.command);
  if (event?.args?.cmd) return String(event.args.cmd);
  return String(event?.toolName || "tool");
}

function exitCode(event) {
  return event?.exitCode
    ?? event?.result?.details?.exitCode
    ?? event?.result?.details?.exit_code
    ?? event?.result?.details?.code
    ?? (event?.isError ? 1 : 0);
}

function progressKey(event, fallback) {
  const eventType = event.eventType || event.type || fallback;
  if (event.toolCallId) return `progress-${eventType}-${event.toolCallId}`;
  return `progress-${eventType || fallback}`;
}

function toolProgressKey(event) {
  return event.toolCallId ? `progress-tool-${event.toolCallId}` : `progress-tool-${commandText(event)}`;
}

function upsertProgress(items, key, patch, now, makeId) {
  const id = key || makeId("progress");
  let updated = false;
  const next = items.map((item) => {
    if (item.type !== "progress" || item.key !== id) return item;
    updated = true;
    return { ...item, ...patch, updated_at: now };
  });
  if (updated) return next;
  return [...next, {
    id: makeId("item"),
    key: id,
    type: "progress",
    title: patch.title || "处理中",
    detail: patch.detail || "",
    status: patch.status || "running",
    created_at: now,
    updated_at: now
  }];
}

function appendAssistantText(items, delta, now, makeId) {
  if (!delta) return items;
  let updated = false;
  const next = items.map((item) => {
    if (item.type !== "assistant_message") return item;
    updated = true;
    return { ...item, text: `${item.text || ""}${delta}`, status: "running", updated_at: now };
  });
  if (updated) return next;
  return [...next, {
    id: makeId("item"),
    type: "assistant_message",
    text: delta,
    status: "running",
    created_at: now,
    updated_at: now
  }];
}

function setAssistantText(items, text, now, makeId) {
  if (!text) return items;
  let updated = false;
  const next = items.map((item) => {
    if (item.type !== "assistant_message") return item;
    updated = true;
    return { ...item, text, updated_at: now };
  });
  if (updated) return next;
  return [...next, {
    id: makeId("item"),
    type: "assistant_message",
    text,
    status: "running",
    created_at: now,
    updated_at: now
  }];
}

function appendThinkingText(items, delta, now, makeId) {
  if (!delta) return items;
  let updated = false;
  const next = items.map((item) => {
    if (item.type !== "thinking") return item;
    updated = true;
    return { ...item, text: `${item.text || ""}${delta}`, status: "running", updated_at: now };
  });
  if (updated) return next;
  return [...next, {
    id: makeId("item"),
    type: "thinking",
    title: "思考过程",
    text: delta,
    status: "running",
    created_at: now,
    updated_at: now
  }];
}

function routeMessageDelta(items, delta, now, makeId) {
  if (looksLikeReasoningText(delta)) {
    return upsertProgress(appendThinkingText(items, delta, now, makeId), "progress-thinking", {
      title: "正在思考",
      detail: "",
      status: "running"
    }, now, makeId);
  }
  return upsertProgress(appendAssistantText(items, delta, now, makeId), "progress-output", {
    title: "正在输出结果",
    detail: "",
    status: "running"
  }, now, makeId);
}

function setRoutedMessageText(items, text, now, makeId) {
  if (!text) return items;
  if (looksLikeReasoningText(text)) return appendThinkingText(items, text, now, makeId);
  return setAssistantText(items, text, now, makeId);
}

function upsertCommand(items, event, patch, now, makeId) {
  if (event.toolName && event.toolName !== "bash") return items;
  const id = event.toolCallId ? `command-${event.toolCallId}` : makeId("command");
  let updated = false;
  const next = items.map((item) => {
    if (item.type !== "command" || item.id !== id) return item;
    updated = true;
    return { ...item, ...patch, updated_at: now };
  });
  if (updated) return next;
  return [...next, {
    id,
    type: "command",
    command: commandText(event),
    cwd: event.cwd || "",
    output: "",
    status: "running",
    created_at: now,
    updated_at: now,
    ...patch
  }];
}

function completeItems(items, status, now) {
  return items.map((item) => {
    if (item.status !== "running") return item;
    if (!["assistant_message", "progress", "thinking", "command"].includes(item.type)) return item;
    const patch = item.type === "progress" && status === "completed"
      ? { detail: "AI 已完成本轮任务。" }
      : {};
    return { ...item, ...patch, status, updated_at: now };
  });
}

function toolTitle(event, done = false) {
  const toolName = event.toolName || "工具";
  const command = commandText(event);
  if (toolName === "bash") return done ? `已运行 ${command}` : `正在运行 ${command}`;
  if (toolName === "read") return done ? "已读取文件" : "正在读取文件";
  if (toolName === "write") return done ? "已写入文件" : "正在写入文件";
  if (toolName === "edit") return done ? "已编辑文件" : "正在编辑文件";
  return done ? `已调用 ${toolName}` : `正在调用 ${toolName}`;
}

function commandEventFromItems(items, event) {
  if (event.args?.command || event.args?.cmd || !event.toolCallId) return event;
  const command = items.find((item) => item.type === "command" && item.id === `command-${event.toolCallId}`)?.command;
  return command ? { ...event, args: { ...(event.args || {}), command } } : event;
}

function applyEventToItems(items, event, now, makeId) {
  const eventType = event.eventType || event.type;
  const failedEvent = eventType === "extension_error" || (eventType === "auto_retry_end" && event.success === false);

  if (eventType === "agent_start") {
    return upsertProgress(items, progressKey(event), { title: "AI 开始处理", detail: "", status: "running" }, now, makeId);
  }

  if (eventType === "turn_start") {
    return upsertProgress(items, progressKey(event), { title: "开始一轮推理", detail: "", status: "running" }, now, makeId);
  }

  if (eventType === "message_update") {
    if (event.deltaType === "text_delta") {
      return routeMessageDelta(items, event.delta || "", now, makeId);
    }
    if (event.deltaType === "thinking_delta") {
      return upsertProgress(appendThinkingText(items, event.delta || "", now, makeId), "progress-thinking", {
        title: "正在思考",
        detail: "",
        status: "running"
      }, now, makeId);
    }
  }

  if (eventType === "message_end") {
    if (event.messageRole && event.messageRole !== "assistant") return items;
    const text = event.text || messageText(event.message);
    return setRoutedMessageText(items, text, now, makeId);
  }

  if (eventType === "turn_end" && event.text) {
    return setRoutedMessageText(items, event.text, now, makeId);
  }

  if (eventType === "tool_execution_start") {
    const command = commandText(event);
    return upsertProgress(upsertCommand(items, event, {
      command,
      cwd: event.cwd || "",
      status: "running"
    }, now, makeId), toolProgressKey(event), {
      title: toolTitle(event, false),
      detail: event.toolName === "bash" ? "" : command,
      status: "running"
    }, now, makeId);
  }

  if (eventType === "tool_execution_update") {
    return upsertCommand(items, event, {
      output: resultText(event.partialResult),
      status: "running"
    }, now, makeId);
  }

  if (eventType === "tool_execution_end") {
    const commandEvent = commandEventFromItems(items, event);
    return upsertProgress(upsertCommand(items, commandEvent, {
      output: resultText(event.result),
      exit_code: exitCode(event),
      status: event.isError ? "failed" : "completed"
    }, now, makeId), toolProgressKey(commandEvent), {
      title: event.isError ? `${toolTitle(commandEvent, true)}失败` : toolTitle(commandEvent, true),
      detail: "",
      status: event.isError ? "failed" : "completed"
    }, now, makeId);
  }

  if (eventType === "agent_end") {
    return upsertProgress(completeItems(items, "completed", now), progressKey(event), {
      title: "AI 已完成本轮任务",
      detail: "",
      status: "completed"
    }, now, makeId);
  }

  if (failedEvent) {
    return [...completeItems(items, "failed", now), {
      id: makeId("item"),
      type: "error",
      title: "执行失败",
      detail: event.error || event.finalError || event.errorMessage || "Pi 执行失败",
      status: "failed",
      created_at: now,
      updated_at: now
    }];
  }

  return items;
}

export function applyPiIdeTimelineEvent(turns, event, options = {}) {
  if (!event || event.kind !== "timeline") return turns;
  const list = Array.isArray(turns) ? turns : [];
  const index = latestTurnIndex(list);
  if (index < 0) return list;

  const now = options.now || event.timestamp || new Date().toISOString();
  const makeId = options.makeId || ((prefix) => `${prefix}-${Math.random().toString(16).slice(2)}`);
  const eventType = event.eventType || event.type;
  const failedEvent = eventType === "extension_error" || (eventType === "auto_retry_end" && event.success === false);
  const finalStatus = eventType === "agent_end" ? "completed"
    : failedEvent ? "failed"
    : undefined;

  return list.map((turn, turnIndex) => {
    if (turnIndex !== index) return turn;
    return {
      ...turn,
      status: finalStatus || turn.status || "running",
      items: applyEventToItems(Array.isArray(turn.items) ? turn.items : [], event, now, makeId),
      updated_at: now
    };
  });
}
