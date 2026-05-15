export function stripAnsiText(text) {
  return String(text || "")
    .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, "")
    .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");
}

export function isPiStartupOutput(text) {
  const value = stripAnsiText(text).replace(/\x07/g, "").trim();
  if (!value) return false;
  const markers = [
    /(?:^|\n)\s*0;(?:pi|npm|π - agent)/i,
    /\bWelcome back!\b/i,
    /\bTips\b/i,
    /\bLoaded\b/i,
    /Recent sessions/i,
    /Press any key to continue/i,
    /\[Prompts\]/i,
    /\[Extensions\]/i,
    /Update Available/i,
    /Package Updates Available/i,
    /npm root/i,
    /npm view pi-intercom version/i,
    /@earendil-works\/pi-coding-agent/i,
    /earendil-works\/pi/i,
    /pi\.dev/i
  ];
  return markers.filter((pattern) => pattern.test(value)).length >= 2;
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

  if (type === "note") {
    return {
      ...base,
      title: String(item.title || "操作说明"),
      text: stripAnsiText(item.text || item.detail || "")
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
      text: stripAnsiText(item.text || ""),
      round: Number.isInteger(item.round) ? item.round : undefined,
      roundClosed: Boolean(item.roundClosed)
    };
  }

  if (type === "command") {
    return {
      ...base,
      toolCallId: String(item.tool_call_id || item.toolCallId || "").trim(),
      toolName: String(item.tool_name || item.toolName || ""),
      args: item.args && typeof item.args === "object" ? item.args : {},
      command: String(item.command || ""),
      cwd: String(item.cwd || ""),
      output: stripAnsiText(item.output || ""),
      exitCode: item.exit_code ?? item.exitCode ?? null
    };
  }

  if (type === "subagent_group") {
    return {
      ...base,
      title: String(item.title || "子 Agent"),
      runs: (Array.isArray(item.runs) ? item.runs : []).map((run, runIndex) => ({
        id: String(run.id || `subagent-${runIndex}`),
        agent_name: String(run.agent_name || run.name || run.role || "subagent"),
        role: String(run.role || ""),
        task: String(run.task || ""),
        action: String(run.action || ""),
        status: run.status || "completed",
        model: run.model || null,
        cwd: String(run.cwd || ""),
        session_file: String(run.session_file || run.sessionFile || ""),
        summary: stripAnsiText(run.summary || ""),
        started_at: run.started_at || run.startedAt || "",
        ended_at: run.ended_at || run.endedAt || "",
        updated_at: run.updated_at || run.updatedAt || "",
        items: Array.isArray(run.items) ? run.items.map(normalizeTimelineItem) : [],
        files: Array.isArray(run.files) ? run.files : []
      }))
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
  const output = isPiStartupOutput(session.output) ? "" : stripAnsiText(session.output || "").trim();
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
      output ? normalizeTimelineItem({
        id: `${session.id || "session"}-fallback-assistant`,
        type: "assistant_message",
        text: output,
        status: output ? "completed" : "pending",
        updated_at: session.updated_at
      }, 1) : null
    ].filter(Boolean)
  }];
}
