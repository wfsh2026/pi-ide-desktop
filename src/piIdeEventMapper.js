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

function setThinkingText(items, text, now, makeId) {
  if (!text) return items;
  let updated = false;
  const next = items.map((item) => {
    if (item.type !== "thinking") return item;
    updated = true;
    return { ...item, text, thinking_blocks: undefined, updated_at: now };
  });
  if (updated) return next;
  return [...next, {
    id: makeId("item"),
    type: "thinking",
    title: "思考过程",
    text,
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
    if (item.type !== "thinking") return item;
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
  const thinking_blocks = { [blockKey]: text };
  return [...next, {
    id: makeId("item"),
    type: "thinking",
    title: "思考过程",
    thinking_blocks,
    text: orderedBlockText(thinking_blocks),
    status: "running",
    created_at: now,
    updated_at: now
  }];
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
  if (routed.answer) next = setAssistantText(next, routed.answer, now, makeId);
  return next;
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

function agentDefinitionPath(event) {
  const raw = event?.args?.path || event?.input?.path || event?.path || "";
  const value = String(raw || "").trim();
  if (!value) return "";
  return /(^|[\\/])\.pi[\\/]agents[\\/][^\\/]+\.md$/i.test(value) ? value : "";
}

function fileNameFromPath(value) {
  return String(value || "").split(/[\\/]/).filter(Boolean).pop() || String(value || "");
}

function agentNameFromPath(value) {
  return fileNameFromPath(value).replace(/\.md$/i, "") || "subagent";
}

function isIntercomTool(event) {
  return /^intercom$/i.test(String(event?.toolName || ""));
}

function intercomName(event) {
  const args = event?.args || event?.input || {};
  return String(args.target || args.to || args.session || args.sessionId || args.name || "intercom").trim();
}

function intercomTask(event) {
  const args = event?.args || event?.input || {};
  return String(args.message || args.task || args.prompt || args.input || commandText(event)).trim();
}

function subagentRunId(event) {
  return String(event?.runId || event?.run_id || event?.toolCallId || event?.id || "subagent");
}

function subagentAgentName(event) {
  return String(event?.agentName || event?.agent || event?.name || event?.role || event?.toolName || "subagent").trim();
}

function subagentStatus(eventType, event) {
  if (event?.status) return event.status;
  if (eventType === "subagent_definition") return "defined";
  if (eventType === "subagent_end") return event.isError ? "failed" : "completed";
  if (eventType === "subagent_error") return "failed";
  return "running";
}

function appendSubagentMessage(run, text, now, makeId, append = false) {
  const value = String(text || "").trim();
  if (!value) return run;
  const last = [...(run.items || [])].reverse().find((item) => item.type === "assistant_message");
  const nextItems = (run.items || []).map((item) => {
    if (!last || item.id !== last.id) return item;
    return { ...item, text: append ? `${item.text || ""}${value}` : value, updated_at: now };
  });
  if (last) return { ...run, items: nextItems };
  return {
    ...run,
    items: [...(run.items || []), {
      id: makeId("subagent-message"),
      type: "assistant_message",
      text: value,
      status: "running",
      created_at: now,
      updated_at: now
    }]
  };
}

function mergeSubagentRun(run, event, now, makeId) {
  const eventType = event.eventType || event.type;
  const status = subagentStatus(eventType, event);
  let next = {
    id: subagentRunId(event),
    agent_name: subagentAgentName(event),
    role: event.role || "",
    task: event.task || "",
    action: event.action || "",
    model: event.model,
    cwd: event.cwd || "",
    status,
    started_at: now,
    updated_at: now,
    items: [],
    files: [],
    ...(run || {})
  };

  next = {
    ...next,
    agent_name: subagentAgentName(event) || next.agent_name,
    role: event.role || next.role,
    task: event.task || next.task,
    action: event.action || next.action,
    model: event.model || next.model,
    cwd: event.cwd || next.cwd,
    status,
    session_file: event.sessionFile || event.session_file || next.session_file,
    updated_at: now,
    ended_at: status === "completed" || status === "failed" ? now : next.ended_at
  };

  if (eventType === "subagent_start") {
    next.items = upsertProgress(next.items || [], `subagent-progress-${next.id}`, {
      title: `子 Agent ${next.agent_name} 已启动`,
      detail: next.task,
      status: "running"
    }, now, makeId);
  } else if (eventType === "subagent_message") {
    next = appendSubagentMessage(next, event.text || event.delta || event.summary, now, makeId, Boolean(event.delta && !event.text));
  } else if (eventType === "subagent_end") {
    next.summary = event.summary || event.text || next.summary || "";
    if (next.summary) next = appendSubagentMessage(next, next.summary, now, makeId);
    next.items = upsertProgress(completeItems(next.items || [], status, now), `subagent-progress-${next.id}`, {
      title: status === "failed" ? `子 Agent ${next.agent_name} 执行失败` : `子 Agent ${next.agent_name} 已完成`,
      detail: "",
      status
    }, now, makeId);
  } else if (eventType === "subagent_definition") {
    next.summary = event.summary || next.summary || "";
    next.items = upsertProgress(next.items || [], `subagent-progress-${next.id}`, {
      title: `子 Agent ${next.agent_name} 已定义`,
      detail: event.path || next.task,
      status: "completed"
    }, now, makeId);
  } else if (eventType === "subagent_error") {
    next.items = [...completeItems(next.items || [], "failed", now), {
      id: makeId("subagent-error"),
      type: "error",
      title: `子 Agent ${next.agent_name} 执行失败`,
      detail: event.error || event.message || "Subagent failed",
      status: "failed",
      created_at: now,
      updated_at: now
    }];
  } else {
    next.items = applyEventToItems(next.items || [], { ...event, kind: "timeline" }, now, makeId);
  }

  const artifactPaths = Array.isArray(event.artifactPaths) ? event.artifactPaths : [];
  const explicitPaths = event.path ? [event.path, ...artifactPaths] : artifactPaths;
  const files = explicitPaths.map((path) => ({
    path,
    name: fileNameFromPath(path),
    source: eventType === "subagent_definition" ? "subagent-definition" : "subagent-artifact"
  }));
  const existing = new Set((next.files || []).map((file) => file.path || file.name));
  next.files = [...(next.files || []), ...files.filter((file) => !existing.has(file.path || file.name))];
  return next;
}

function applySubagentEventToItems(items, event, now, makeId) {
  const runId = subagentRunId(event);
  let foundGroup = false;
  const next = items.map((item) => {
    if (item.type !== "subagent_group") return item;
    foundGroup = true;
    let foundRun = false;
    const runs = (item.runs || []).map((run) => {
      if (String(run.id) !== runId) return run;
      foundRun = true;
      return mergeSubagentRun(run, event, now, makeId);
    });
    if (!foundRun) runs.push(mergeSubagentRun(null, event, now, makeId));
    const status = runs.some((run) => run.status === "running") ? "running" : runs.some((run) => run.status === "failed") ? "failed" : "completed";
    return { ...item, runs, status, updated_at: now };
  });
  if (foundGroup) return next;
  const run = mergeSubagentRun(null, event, now, makeId);
  return [...next, {
    id: makeId("subagents"),
    type: "subagent_group",
    title: "子 Agent",
    status: run.status || "running",
    runs: [run],
    created_at: now,
    updated_at: now
  }];
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
        return upsertProgress(setAssistantBlockText(nextItems, event.contentIndex, blockText, now, makeId), "progress-output", {
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
        return setAssistantBlockText(nextItems, event.contentIndex, text, now, makeId);
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
      return upsertProgress(updatedItems, "progress-thinking", {
        title: "正在思考",
        detail: "",
        status: "running"
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
    let nextItems = upsertProgress(upsertCommand(items, event, {
      command,
      cwd: event.cwd || "",
      status: "running"
    }, now, makeId), toolProgressKey(event), {
      title: toolTitle(event, false),
      detail: event.toolName === "bash" ? "" : command,
      status: "running"
    }, now, makeId);
    const definitionPath = agentDefinitionPath(event);
    if (definitionPath) {
      nextItems = applySubagentEventToItems(nextItems, {
        kind: "subagent",
        eventType: "subagent_definition",
        runId: `definition:${definitionPath}`,
        agentName: agentNameFromPath(definitionPath),
        task: `定义子 Agent ${agentNameFromPath(definitionPath)}`,
        path: definitionPath,
        summary: `已创建或更新子 Agent 定义：${definitionPath}`
      }, now, makeId);
    }
    if (isIntercomTool(event)) {
      nextItems = applySubagentEventToItems(nextItems, {
        ...event,
        kind: "subagent",
        eventType: "subagent_start",
        runId: subagentRunId(event),
        agentName: intercomName(event),
        task: intercomTask(event),
        action: "intercom"
      }, now, makeId);
    }
    return nextItems;
  }

  if (eventType === "tool_execution_update") {
    return upsertCommand(items, event, {
      output: resultText(event.partialResult),
      status: "running"
    }, now, makeId);
  }

  if (eventType === "tool_execution_end") {
    const commandEvent = commandEventFromItems(items, event);
    let nextItems = upsertProgress(upsertCommand(items, commandEvent, {
      output: resultText(event.result),
      exit_code: exitCode(event),
      status: event.isError ? "failed" : "completed"
    }, now, makeId), toolProgressKey(commandEvent), {
      title: event.isError ? `${toolTitle(commandEvent, true)}失败` : toolTitle(commandEvent, true),
      detail: "",
      status: event.isError ? "failed" : "completed"
    }, now, makeId);
    if (isIntercomTool(event)) {
      nextItems = applySubagentEventToItems(nextItems, {
        ...event,
        kind: "subagent",
        eventType: "subagent_end",
        runId: subagentRunId(event),
        agentName: intercomName(event),
        task: intercomTask(event),
        summary: resultText(event.result),
        status: event.isError ? "failed" : "completed",
        isError: Boolean(event.isError)
      }, now, makeId);
    }
    return nextItems;
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
  if (!event || !["timeline", "subagent"].includes(event.kind)) return turns;
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
    const currentItems = Array.isArray(turn.items) ? turn.items : [];
    return {
      ...turn,
      status: finalStatus || turn.status || "running",
      items: event.kind === "subagent"
        ? applySubagentEventToItems(currentItems, event, now, makeId)
        : applyEventToItems(currentItems, event, now, makeId),
      updated_at: now
    };
  });
}
