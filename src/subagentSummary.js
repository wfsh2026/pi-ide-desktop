function fileName(path) {
  return String(path || "").split(/[\\/]/).filter(Boolean).pop() || String(path || "");
}

function normalizeFile(file, source = "") {
  if (!file) return null;
  const path = typeof file === "string" ? file : file.path;
  const name = typeof file === "string" ? fileName(file) : file.name || fileName(file.path);
  if (!path && !name) return null;
  return { ...(typeof file === "string" ? {} : file), path: path || name, name: name || path, source: source || file.source || "" };
}

function addFiles(target, files, source = "") {
  for (const file of Array.isArray(files) ? files : []) {
    const next = normalizeFile(file, source);
    if (!next) continue;
    const key = next.path || next.name;
    if (!target.some((item) => (item.path || item.name) === key)) target.push(next);
  }
}

function collectRunFiles(run) {
  const referencedFiles = [];
  const outputFiles = [];
  const relatedFiles = [];

  for (const item of Array.isArray(run?.items) ? run.items : []) {
    if (item?.type === "file_reference") addFiles(referencedFiles, item.files, item.title || "subagent-reference");
    else if (item?.type === "file_output") addFiles(outputFiles, item.files, item.title || "subagent-output");
  }

  for (const file of Array.isArray(run?.files) ? run.files : []) {
    const source = String(file?.source || "");
    if (/artifact|output|write|changed/i.test(source)) addFiles(outputFiles, [file], source);
    else addFiles(relatedFiles, [file], source || "subagent-file");
  }

  return { referencedFiles, outputFiles, relatedFiles };
}

function collectSubagentRuns(session) {
  const runs = [];
  for (const turn of Array.isArray(session?.turns) ? session.turns : []) {
    for (const item of Array.isArray(turn?.items) ? turn.items : []) {
      if (item?.type !== "subagent_group") continue;
      for (const run of Array.isArray(item.runs) ? item.runs : []) runs.push(run || {});
    }
  }
  return runs;
}

export function collectSessionSubagents(session) {
  return collectSubagentRuns(session).map((run, index) => {
    const files = collectRunFiles(run);
    return {
      id: String(run.id || `subagent-${index}`),
      name: String(run.agent_name || run.name || run.role || "subagent"),
      role: String(run.role || ""),
      task: String(run.task || ""),
      action: String(run.action || ""),
      status: run.status || "completed",
      model: run.model || null,
      cwd: String(run.cwd || ""),
      sessionFile: String(run.session_file || run.sessionFile || ""),
      summary: String(run.summary || ""),
      startedAt: run.started_at || run.startedAt || "",
      endedAt: run.ended_at || run.endedAt || "",
      updatedAt: run.updated_at || run.updatedAt || "",
      items: Array.isArray(run.items) ? run.items : [],
      files: Array.isArray(run.files) ? run.files : [],
      ...files
    };
  });
}

export function sessionSubagentSummary(session) {
  const runs = collectSessionSubagents(session);
  if (runs.length === 0) return null;
  const running = runs.filter((run) => run.status === "running").length;
  const failed = runs.filter((run) => run.status === "failed").length;
  const defined = runs.filter((run) => run.status === "defined").length;
  if (running > 0) return `子 Agent ${runs.length} 个 · ${running} 运行中`;
  if (failed > 0) return `子 Agent ${runs.length} 个 · ${failed} 失败`;
  if (defined === runs.length) return `子 Agent ${runs.length} 个 · 已定义`;
  return `子 Agent ${runs.length} 个`;
}
