export const DEFAULT_STORAGE_LIMITS = {
  terminalPreviewChars: 64 * 1024,
  sessionTextPreviewChars: 128 * 1024,
  sessionTurnLimit: 50,
  sessionFileRecordLimit: 500
};

const QUOTA_STORAGE_LIMITS = {
  terminalPreviewChars: 1,
  sessionTextPreviewChars: 16 * 1024,
  sessionTurnLimit: 20,
  sessionFileRecordLimit: 200
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
    sessionFileRecordLimit: positiveInteger(limits.sessionFileRecordLimit, DEFAULT_STORAGE_LIMITS.sessionFileRecordLimit)
  };
}

function limitArrayTail(value, limit) {
  const list = Array.isArray(value) ? value : [];
  if (list.length <= limit) return list;
  return list.slice(-limit);
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
  if (Array.isArray(next.items)) {
    next.items = next.items.map((child) => compactTimelineItem(child, limits));
  }
  if (Array.isArray(next.runs)) {
    next.runs = next.runs.map((run) => {
      const compactRun = { ...run };
      for (const key of ["task", "summary", "cwd", "session_file"]) {
        if (typeof compactRun[key] === "string") {
          const limited = limitTextValue(compactRun[key], limits.sessionTextPreviewChars);
          compactRun[key] = limited.text;
          if (limited.truncated) compactRun[`${key}_truncated`] = true;
        }
      }
      if (Array.isArray(compactRun.items)) {
        compactRun.items = compactRun.items.map((child) => compactTimelineItem(child, limits));
      }
      if (Array.isArray(compactRun.files)) {
        compactRun.files = limitArrayTail(compactRun.files, limits.sessionFileRecordLimit);
      }
      return compactRun;
    });
  }
  return next;
}

function compactTurn(turn, limits) {
  if (!turn || typeof turn !== "object") return turn;
  return {
    ...turn,
    items: Array.isArray(turn.items) ? turn.items.map((item) => compactTimelineItem(item, limits)) : []
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
    sessions: (Array.isArray(project?.sessions) ? project.sessions : []).map((session) => compactSession(session, merged))
  }));
}

function compactModel(model) {
  if (!model || typeof model !== "object") return null;
  return {
    id: model.id || model.model || "",
    name: model.name || model.id || model.model || "",
    provider: model.provider || "",
    api: model.api || ""
  };
}

function compactQuotaSession(session) {
  const compact = compactSession(session, QUOTA_STORAGE_LIMITS);
  return {
    id: compact.id,
    title: compact.title,
    created_at: compact.created_at,
    updated_at: compact.updated_at,
    archived: compact.archived,
    archived_at: compact.archived_at,
    user_renamed: compact.user_renamed,
    first_prompt: limitTextValue(compact.first_prompt || "", QUOTA_STORAGE_LIMITS.sessionTextPreviewChars).text,
    draft_command: limitTextValue(compact.draft_command || "", 4096).text,
    workdir: compact.workdir,
    output: "",
    output_truncated: Boolean(compact.output || compact.output_truncated),
    output_bytes: Number(compact.output_bytes) || 0,
    turns: compact.turns,
    turns_truncated: compact.turns_truncated,
    referenced_files: limitArrayTail(compact.referenced_files, QUOTA_STORAGE_LIMITS.sessionFileRecordLimit),
    output_files: limitArrayTail(compact.output_files, QUOTA_STORAGE_LIMITS.sessionFileRecordLimit),
    attachments: limitArrayTail(compact.attachments, 50),
    current_model: compactModel(compact.current_model),
    pending_model: compactModel(compact.pending_model)
  };
}

export function normalizeStoredProjectsForQuota(projects) {
  return (Array.isArray(projects) ? projects : []).map((project) => ({
    id: project?.id,
    name: project?.name,
    path: project?.path,
    created_at: project?.created_at,
    updated_at: project?.updated_at,
    collapsed: project?.collapsed,
    archived: project?.archived,
    archived_at: project?.archived_at,
    sessions: (Array.isArray(project?.sessions) ? project.sessions : []).map(compactQuotaSession)
  }));
}

export function resolveActiveProjectSession(projects, activeProjectId, activeSessionId) {
  const list = Array.isArray(projects) ? projects : [];
  const activeProject = list.find((project) => project?.id === activeProjectId && !project.archived);
  const activeSession = activeProject?.sessions?.find((session) => session?.id === activeSessionId && !session.archived);
  if (activeProject && activeSession) {
    return { projectId: activeProject.id, sessionId: activeSession.id };
  }

  const nextProject = list.find((project) => !project?.archived && (project?.sessions || []).some((session) => !session?.archived));
  const nextSession = nextProject?.sessions?.find((session) => !session?.archived);
  return {
    projectId: nextProject?.id || null,
    sessionId: nextSession?.id || null
  };
}
