export function stripAnsiText(text) {
  return String(text || "").replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");
}

export function splitMarkdownSections(text) {
  const lines = stripAnsiText(text).replace(/\r\n/g, "\n").split("\n");
  const sections = [];
  let current = [];
  let code = null;

  function pushText() {
    const value = current.join("\n").trimEnd();
    if (value.trim()) sections.push({ type: "text", text: value });
    current = [];
  }

  for (const line of lines) {
    const fence = line.match(/^```([A-Za-z0-9_-]*)\s*$/);
    if (fence) {
      if (code) {
        sections.push({ type: "code", language: code.language, text: code.lines.join("\n") });
        code = null;
      } else {
        pushText();
        code = { language: fence[1] || "", lines: [] };
      }
      continue;
    }

    if (code) code.lines.push(line);
    else current.push(line);
  }

  if (code) sections.push({ type: "code", language: code.language, text: code.lines.join("\n") });
  else pushText();

  return sections;
}

function normalizeTimelineItem(item, index) {
  const type = item?.type || "assistant_message";
  const base = {
    id: item?.id || `item-${index}`,
    type,
    status: item?.status || "completed",
    createdAt: item?.created_at || item?.createdAt || "",
    updatedAt: item?.updated_at || item?.updatedAt || ""
  };

  if (type === "user_message") {
    return {
      ...base,
      text: String(item.text || item.user_text || ""),
      finalPrompt: String(item.final_prompt || item.finalPrompt || ""),
      attachments: Array.isArray(item.attachments) ? item.attachments : []
    };
  }

  if (type === "progress") {
    return {
      ...base,
      title: String(item.title || "处理中"),
      detail: String(item.detail || "")
    };
  }

  if (type === "file_reference" || type === "file_output") {
    return {
      ...base,
      title: String(item.title || (type === "file_output" ? "AI 输出文件" : "AI 参考文件")),
      files: Array.isArray(item.files) ? item.files : []
    };
  }

  if (type === "error") {
    return {
      ...base,
      title: String(item.title || "执行失败"),
      detail: stripAnsiText(item.detail || item.text || "")
    };
  }

  if (type === "thinking") {
    return {
      ...base,
      title: String(item.title || "思考过程"),
      text: stripAnsiText(item.text || "")
    };
  }

  if (type === "command") {
    return {
      ...base,
      command: String(item.command || ""),
      cwd: String(item.cwd || ""),
      output: stripAnsiText(item.output || ""),
      exitCode: item.exit_code ?? item.exitCode ?? null
    };
  }

  return {
    ...base,
    text: stripAnsiText(item.text || item.output || "")
  };
}

function normalizeTurn(turn, index, session) {
  const items = Array.isArray(turn.items) && turn.items.length > 0
    ? turn.items.map(normalizeTimelineItem)
    : [
        turn.user_text || turn.userText ? normalizeTimelineItem({
          id: `${turn.id || index}-user`,
          type: "user_message",
          text: turn.user_text || turn.userText,
          final_prompt: turn.final_prompt || turn.finalPrompt,
          attachments: turn.attachments,
          created_at: turn.created_at || session.created_at
        }, 0) : null,
        normalizeTimelineItem({
          id: `${turn.id || index}-assistant`,
          type: "assistant_message",
          text: turn.output || "",
          status: turn.status || "completed",
          created_at: turn.created_at || session.created_at,
          updated_at: turn.updated_at || session.updated_at
        }, 1)
      ].filter(Boolean);

  return {
    id: turn.id || `turn-${index}`,
    status: turn.status || "completed",
    createdAt: turn.created_at || turn.createdAt || session.created_at || "",
    updatedAt: turn.updated_at || turn.updatedAt || session.updated_at || "",
    items
  };
}

export function buildSessionTimeline(session) {
  if (!session) return [];

  const turns = Array.isArray(session.turns) ? session.turns.filter(Boolean) : [];
  if (turns.length > 0) {
    return turns.map((turn, index) => normalizeTurn(turn, index, session));
  }

  const firstPrompt = String(session.first_prompt || "").trim();
  const output = stripAnsiText(session.output || "").trim();
  if (!firstPrompt && !output) return [];

  return [{
    id: `${session.id || "session"}-fallback`,
    status: output ? "completed" : "pending",
    createdAt: session.created_at || "",
    updatedAt: session.updated_at || "",
    items: [
      firstPrompt ? normalizeTimelineItem({
        id: `${session.id || "session"}-fallback-user`,
        type: "user_message",
        text: firstPrompt,
        final_prompt: firstPrompt,
        attachments: Array.isArray(session.attachments) ? session.attachments : [],
        created_at: session.created_at
      }, 0) : null,
      normalizeTimelineItem({
        id: `${session.id || "session"}-fallback-assistant`,
        type: "assistant_message",
        text: output,
        status: output ? "completed" : "pending",
        updated_at: session.updated_at
      }, 1)
    ].filter(Boolean)
  }];
}
