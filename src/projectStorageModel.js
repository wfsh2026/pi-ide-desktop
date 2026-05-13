export const DEFAULT_STORAGE_LIMITS = {
  terminalPreviewChars: 256 * 1024,
  sessionTextPreviewChars: 128 * 1024,
  sessionTurnLimit: 50,
  sessionFileRecordLimit: 500
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
