// ─── Session Debug Logging ──────────────────────────────────────────
let sessionDebugEnabled = false;

function initSessionDebug() {
  try {
    if (typeof localStorage !== "undefined" && localStorage.getItem("piIdeSessionDebug") === "1") {
      sessionDebugEnabled = true;
    }
  } catch (_) { /* ignore */ }
}
initSessionDebug();

function sessionDebug(category, message, data) {
  if (!sessionDebugEnabled) return;
  try {
    console.log(`[pi-ide:${category}]`, message, data !== undefined ? safeClone(data) : "");
  } catch (_) { /* ignore */ }
}

function safeClone(value) {
  try {
    return JSON.parse(JSON.stringify(value, (_k, v) => {
      if (typeof v === "string" && v.length > 500) return v.slice(0, 500) + "…(truncated)";
      return v;
    }));
  } catch (_) {
    return String(value).slice(0, 500);
  }
}

// ─── Turn Helpers ───────────────────────────────────────────────────

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
    /^看起来(?:像|是)/
  ];
  return englishReasoningMarkers.some((pattern) => pattern.test(value))
    || chineseReasoningMarkers.some((pattern) => pattern.test(value));
}

function hasCjkText(text) {
  return /[\u3400-\u9fff]/.test(String(text || ""));
}

function splitReasoningAndAnswer(text) {
  const value = String(text || "").replace(/\r\n/g, "\n");
  if (!value.trim()) return { reasoning: "", answer: "" };
  if (!looksLikeReasoningText(value)) return { reasoning: "", answer: value };

  const lines = value.split("\n");
  let answerStart = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    if (looksLikeReasoningText(line)) continue;
    if (hasCjkText(line)) {
      answerStart = index;
      break;
    }
  }

  if (answerStart < 0) return { reasoning: value, answer: "" };
  return {
    reasoning: lines.slice(0, answerStart).join("\n").trim(),
    answer: lines.slice(answerStart).join("\n").trimStart()
  };
}

function commandText(event) {
  if (event?.args?.command) return String(event.args.command);
  if (event?.args?.cmd) return String(event.args.cmd);
  const toolName = String(event?.toolName || "tool");
  const args = event?.args && typeof event.args === "object" ? event.args : {};
  const path = args.path || args.file || args.filePath || args.target || args.targetPath;
  return path ? `${toolName} ${path}` : toolName;
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
    return { ...item, text, text_blocks: undefined, updated_at: now };
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

function contentBlockKey(index) {
  const value = Number(index);
  return Number.isInteger(value) && value >= 0 ? String(value) : "main";
}

function orderedBlockText(blocks) {
  const entries = Object.entries(blocks || {}).filter(([, text]) => text);
  return entries.sort(([left], [right]) => {
    if (left === right) return 0;
    if (left === "main") return 1;
    if (right === "main") return -1;
    return Number(left) - Number(right);
  }).map(([, text]) => text).join("");
}

function setAssistantBlockText(items, contentIndex, text, now, makeId) {
  if (!text) return items;
  const blockKey = contentBlockKey(contentIndex);
  let updated = false;
  const next = items.map((item) => {
    if (item.type !== "assistant_message") return item;
    updated = true;
    const text_blocks = { ...(item.text_blocks || {}), [blockKey]: text };
    return {
      ...item,
      text_blocks,
      text: orderedBlockText(text_blocks),
      status: "running",
      updated_at: now
    };
  });
  if (updated) return next;
  const text_blocks = { [blockKey]: text };
  return [...next, {
    id: makeId("item"),
    type: "assistant_message",
    text_blocks,
    text: orderedBlockText(text_blocks),
    status: "running",
    created_at: now,
    updated_at: now
  }];
}

function nextThinkingRound(items) {
  let maxRound = 0;
  for (const item of items) {
    if (item.type === "thinking" && typeof item.round === "number" && item.round > maxRound) {
      maxRound = item.round;
    }
  }
  return maxRound + 1;
}

function closeLastThinkingRound(items, now) {
  let closed = false;
  const next = items.map((item) => {
    if (item.type === "thinking" && !item.roundClosed && !closed) {
      closed = true;
      sessionDebug("thinking", "close-last-round", { round: item.round, textLen: (item.text || "").length });
      return { ...item, roundClosed: true, status: "completed", updated_at: now };
    }
    return item;
  });
  if (!closed) sessionDebug("thinking", "no-open-round-to-close", {});
  return next;
}

function appendThinkingText(items, delta, now, makeId) {
  if (!delta) return items;
  let updated = false;
  const next = items.map((item) => {
    if (item.type !== "thinking" || item.roundClosed) return item;
    updated = true;
    return { ...item, text: `${item.text || ""}${delta}`, status: "running", updated_at: now };
  });
  if (updated) {
    sessionDebug("thinking", "append-delta", { deltaLen: delta.length });
    return next;
  }
  const round = nextThinkingRound(items);
  sessionDebug("thinking", "new-round", { round, deltaLen: delta.length, totalRounds: round });
  return [...next, {
    id: makeId("item"),
    type: "thinking",
    title: `思考过程 ${round}`,
    text: delta,
    round,
    status: "running",
    created_at: now,
    updated_at: now
  }];
}

function setThinkingText(items, text, now, makeId) {
  if (!text) return items;
  let updated = false;
  const next = items.map((item) => {
    if (item.type !== "thinking" || item.roundClosed) return item;
    updated = true;
    return { ...item, text, thinking_blocks: undefined, updated_at: now };
  });
  if (updated) return next;
  const round = nextThinkingRound(items);
  return [...next, {
    id: makeId("item"),
    type: "thinking",
    title: `思考过程 ${round}`,
    text,
    round,
    status: "running",
    created_at: now,
    updated_at: now
  }];
}

function setThinkingBlockText(items, contentIndex, text, now, makeId) {
  if (!text) return items;
  const blockKey = contentBlockKey(contentIndex);
  let updated = false;
  const next = items.map((item) => {
    if (item.type !== "thinking" || item.roundClosed) return item;
    updated = true;
    const thinking_blocks = { ...(item.thinking_blocks || {}), [blockKey]: text };
    return {
      ...item,
      thinking_blocks,
      text: orderedBlockText(thinking_blocks),
      status: "running",
      updated_at: now
    };
  });
  if (updated) return next;
  const round = nextThinkingRound(items);
  const thinking_blocks = { [blockKey]: text };
  return [...next, {
    id: makeId("item"),
    type: "thinking",
    title: `思考过程 ${round}`,
    thinking_blocks,
    text: orderedBlockText(thinking_blocks),
    round,
    status: "running",
    created_at: now,
    updated_at: now
  }];
}

function appendProcessNote(items, text, now, makeId) {
  const value = String(text || "").trim();
  if (!value) return items;
  return [...items, {
    id: makeId("item"),
    type: "note",
    title: "操作说明",
    text: value,
    status: "completed",
    created_at: now,
    updated_at: now
  }];
}

function transferAssistantPreambleToProcess(items, now, makeId) {
  let noteText = "";
  let noteIndex = -1;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item.type !== "assistant_message") continue;
    const text = String(item.text || "").trim();
    if (!text) break;
    noteText = text;
    noteIndex = index;
    break;
  }
  if (noteIndex < 0) return items;
  const next = items.map((item, index) => {
    if (index !== noteIndex) return item;
    return {
      ...item,
      text: "",
      text_blocks: undefined,
      status: "running",
      updated_at: now
    };
  });
  return appendProcessNote(next, noteText, now, makeId);
}

function firstTextValue(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return "";
}

function eventBlockText(event) {
  return firstTextValue(event?.blockText, event?.partialBlockText);
}

function routeMessageDelta(items, delta, now, makeId) {
  const routed = splitReasoningAndAnswer(delta);
  let next = items;
  if (routed.reasoning) {
    next = upsertProgress(appendThinkingText(next, routed.reasoning, now, makeId), "progress-thinking", {
      title: "正在思考",
      detail: "",
      status: "running"
    }, now, makeId);
  }
  if (routed.answer) {
    next = closeLastThinkingRound(next, now);
    next = upsertProgress(appendAssistantText(next, routed.answer, now, makeId), "progress-output", {
      title: "正在输出结果",
      detail: "",
      status: "running"
    }, now, makeId);
  }
  return next;
}

function setRoutedMessageText(items, text, now, makeId) {
  if (!text) return items;
  const routed = splitReasoningAndAnswer(text);
  let next = items;
  if (routed.reasoning) next = setThinkingText(next, routed.reasoning, now, makeId);
  if (routed.answer) next = setAssistantText(closeLastThinkingRound(next, now), routed.answer, now, makeId);
  return next;
}

function upsertCommand(items, event, patch, now, makeId) {
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
    toolCallId: event.toolCallId || "",
    toolName: event.toolName || "",
    args: event.args && typeof event.args === "object" ? event.args : {},
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
    let nextItems = items;
    if (event.reason) {
      nextItems = upsertProgress(appendThinkingText(nextItems, event.reason, now, makeId), "progress-thinking", {
        title: "正在思考",
        detail: "",
        status: "running"
      }, now, makeId);
    }
    if (event.deltaType === "text_delta") {
      const blockText = eventBlockText(event);
      if (blockText) {
        return upsertProgress(setAssistantBlockText(closeLastThinkingRound(nextItems, now), event.contentIndex, blockText, now, makeId), "progress-output", {
          title: "正在输出结果",
          detail: "",
          status: "running"
        }, now, makeId);
      }
      return routeMessageDelta(nextItems, event.delta || "", now, makeId);
    }
    if (event.deltaType === "text_end") {
      const text = firstTextValue(event.content, eventBlockText(event), event.delta);
      if (event.contentIndex !== undefined && text) {
        return setAssistantBlockText(closeLastThinkingRound(nextItems, now), event.contentIndex, text, now, makeId);
      }
      return setRoutedMessageText(nextItems, text, now, makeId);
    }
    if (event.deltaType === "thinking_delta") {
      const blockText = eventBlockText(event);
      const updatedItems = blockText
        ? setThinkingBlockText(nextItems, event.contentIndex, blockText, now, makeId)
        : appendThinkingText(nextItems, event.delta || "", now, makeId);
      return upsertProgress(updatedItems, "progress-thinking", {
        title: "正在思考",
        detail: "",
        status: "running"
      }, now, makeId);
    }
    if (event.deltaType === "thinking_end") {
      const text = firstTextValue(event.content, eventBlockText(event), event.delta);
      const updatedItems = event.contentIndex !== undefined
        ? setThinkingBlockText(nextItems, event.contentIndex, text, now, makeId)
        : setThinkingText(nextItems, text, now, makeId);
      return upsertProgress(closeLastThinkingRound(updatedItems, now), "progress-thinking", {
        title: "正在思考",
        detail: "",
        status: "completed"
      }, now, makeId);
    }
    return nextItems;
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
    sessionDebug("event", "tool_execution_start", { command, toolName: event.toolName });
    const itemsAfterNote = transferAssistantPreambleToProcess(items, now, makeId);
    const itemsAfterThinking = closeLastThinkingRound(itemsAfterNote, now);
    return upsertProgress(upsertCommand(itemsAfterThinking, event, {
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
    sessionDebug("event", "tool_execution_end", { command: commandText(commandEvent), isError: event.isError, exitCode: exitCode(event) });
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
    sessionDebug("event", "agent_end", { totalItems: items.length });
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
  sessionDebug("event", "incoming", { eventType: event.eventType || event.type, toolName: event.toolName, deltaType: event.deltaType });
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

  const result = list.map((turn, turnIndex) => {
    if (turnIndex !== index) return turn;
    const newItems = applyEventToItems(Array.isArray(turn.items) ? turn.items : [], event, now, makeId);
    const newTurn = {
      ...turn,
      status: finalStatus || turn.status || "running",
      items: newItems,
      updated_at: now
    };
    // Summarize turn state after each event
    const summary = {
      turnStatus: newTurn.status,
      totalItems: newItems.length,
      thinkingItems: newItems.filter((i) => i.type === "thinking").length,
      openThinking: newItems.filter((i) => i.type === "thinking" && !i.roundClosed).length,
      commandItems: newItems.filter((i) => i.type === "command").length,
      runningCommands: newItems.filter((i) => i.type === "command" && i.status === "running").length,
      assistantLen: (newItems.find((i) => i.type === "assistant_message")?.text || "").length
    };
    sessionDebug("turn", "state", summary);
    return newTurn;
  });
  return result;
}
