export const DEFAULT_STORAGE_LIMITS = {
  terminalPreviewChars: 128 * 1024,
  sessionTextPreviewChars: 128 * 1024,
  sessionTurnLimit: 80,
  sessionFileRecordLimit: 500,
  projectSessionLimit: 80
};

export const QUOTA_STORAGE_LIMITS = {
  terminalPreviewChars: 16 * 1024,
  sessionTextPreviewChars: 16 * 1024,
  sessionTurnLimit: 30,
  sessionFileRecordLimit: 120,
  projectSessionLimit: 40
};

export const MINIMAL_STORAGE_LIMITS = {
  terminalPreviewChars: 4 * 1024,
  sessionTextPreviewChars: 4 * 1024,
  sessionTurnLimit: 12,
  sessionFileRecordLimit: 40,
  projectSessionLimit: 20
};

export function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

export function limitTextValue(value, limit) {
  const text = String(value || "");
  const size = positiveInteger(limit, text.length || 1);
  if (text.length <= size) return { text, truncated: false };
  return { text: text.slice(-size), truncated: true };
}

function mergeLimits(limits = {}) {
  return {
    terminalPreviewChars: positiveInteger(limits.terminalPreviewChars, DEFAULT_STORAGE_LIMITS.terminalPreviewChars),
    sessionTextPreviewChars: positiveInteger(limits.sessionTextPreviewChars, DEFAULT_STORAGE_LIMITS.sessionTextPreviewChars),
    sessionTurnLimit: positiveInteger(limits.sessionTurnLimit, DEFAULT_STORAGE_LIMITS.sessionTurnLimit),
    sessionFileRecordLimit: positiveInteger(limits.sessionFileRecordLimit, DEFAULT_STORAGE_LIMITS.sessionFileRecordLimit),
    projectSessionLimit: positiveInteger(limits.projectSessionLimit, DEFAULT_STORAGE_LIMITS.projectSessionLimit),
    closeRunningTurns: Boolean(limits.closeRunningTurns)
  };
}

function limitArrayTail(value, limit) {
  const list = Array.isArray(value) ? value : [];
  if (list.length <= limit) return list;
  return list.slice(-limit);
}

export function resolveStoredActiveSession(projects, activeProjectId, activeSessionId) {
  const projectList = Array.isArray(projects) ? projects : [];
  const project = projectList.find((item) => item?.id === activeProjectId);
  const session = project?.sessions?.find((item) => item?.id === activeSessionId);
  if (project && session) return { projectId: project.id, sessionId: session.id };

  const visibleSessions = Array.isArray(project?.sessions) ? project.sessions.filter((item) => !item.archived) : [];
  const fallbackSession = visibleSessions[visibleSessions.length - 1];
  if (project && fallbackSession) return { projectId: project.id, sessionId: fallbackSession.id };

  return { projectId: null, sessionId: null };
}

function compactTimelineItem(item, limits) {
  if (!item || typeof item !== "object") return item;
  const next = { ...item };
  for (const key of ["text", "detail", "output", "final_prompt", "finalPrompt"]) {
    if (typeof next[key] === "string") {
      const limited = limitTextValue(next[key], limits.sessionTextPreviewChars);
      next[key] = limited.text;
      if (limited.truncated) next[`${key}_truncated`] = true;
    }
  }
  if (Array.isArray(next.files)) {
    next.files = limitArrayTail(next.files, limits.sessionFileRecordLimit);
  }
  if (Array.isArray(next.attachments)) {
    next.attachments = limitArrayTail(next.attachments, limits.sessionFileRecordLimit);
  }
  for (const key of ["text_blocks", "thinking_blocks"]) {
    if (!next[key] || typeof next[key] !== "object") continue;
    if (next.status !== "running") {
      delete next[key];
      continue;
    }
    next[key] = Object.fromEntries(Object.entries(next[key]).map(([blockKey, value]) => {
      const limited = limitTextValue(value, limits.sessionTextPreviewChars);
      return [blockKey, limited.text];
    }));
  }
  return next;
}

function compactTurn(turn, limits) {
  if (!turn || typeof turn !== "object") return turn;
  const shouldClose = limits.closeRunningTurns && turn.status === "running";
  return {
    ...turn,
    status: shouldClose ? "completed" : turn.status,
    items: Array.isArray(turn.items) ? turn.items.map((item) => {
      const itemForCompact = shouldClose && item?.status === "running"
        ? {
            ...item,
            status: "completed",
            detail: item.type === "progress" ? "应用关闭前的未完成过程。" : item.detail
          }
        : item;
      return compactTimelineItem(itemForCompact, limits);
    }) : []
  };
}

function compactSession(session, limits) {
  if (!session || typeof session !== "object") return session;
  const output = limitTextValue(session.output || "", limits.terminalPreviewChars);
  const turns = limitArrayTail(session.turns, limits.sessionTurnLimit).map((turn) => compactTurn(turn, limits));
  return {
    ...session,
    output: output.text,
    output_truncated: Boolean(session.output_truncated || output.truncated),
    turns,
    turns_truncated: Boolean(session.turns_truncated || (Array.isArray(session.turns) && session.turns.length > turns.length)),
    referenced_files: limitArrayTail(session.referenced_files, limits.sessionFileRecordLimit),
    output_files: limitArrayTail(session.output_files, limits.sessionFileRecordLimit),
    attachments: limitArrayTail(session.attachments, limits.sessionFileRecordLimit)
  };
}

export function normalizeStoredProjects(projects, limits = {}) {
  const merged = mergeLimits(limits);
  return (Array.isArray(projects) ? projects : []).map((project) => ({
    ...project,
    sessions: limitArrayTail(Array.isArray(project?.sessions) ? project.sessions : [], merged.projectSessionLimit)
      .map((session) => compactSession(session, merged))
  }));
}
