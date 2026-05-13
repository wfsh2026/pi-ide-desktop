import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import { Square, Send, FolderOpen, Plus, Folder, X, File, FileText, FolderTree, ChevronDown, ChevronRight, RefreshCw, MessageSquare, TerminalSquare, Settings } from "lucide-react";
import PiTerminal from "./components/PiTerminal.jsx";
import SessionTimeline from "./components/SessionTimeline.jsx";
import { applyPiIdeTimelineEvent } from "./piIdeEventMapper.js";
import { DEFAULT_STORAGE_LIMITS, limitTextValue, normalizeStoredProjects, positiveInteger } from "./projectStorageModel.js";

const DEFAULT_COMMAND = "pi";
const PROJECTS_STORAGE_KEY = "piIdeProjects";
const ACTIVE_PROJECT_STORAGE_KEY = "piIdeActiveProjectId";
const ACTIVE_SESSION_STORAGE_KEY = "piIdeActiveProjectSessionId";
const EXE_SESSION_STORAGE_KEY = "piIdeExeSessionId";
const CENTER_VIEW_STORAGE_KEY = "piIdeCenterView";
const TERMINAL_PREVIEW_CHARS_STORAGE_KEY = "piIdeTerminalPreviewChars";
const SESSION_TEXT_PREVIEW_CHARS_STORAGE_KEY = "piIdeSessionTextPreviewChars";
const SESSION_TURN_LIMIT_STORAGE_KEY = "piIdeSessionTurnLimit";
const SESSION_FILE_RECORD_LIMIT_STORAGE_KEY = "piIdeSessionFileRecordLimit";
const DEFAULT_BACKGROUND_PI_IDLE_STOP_MINUTES = 5;
const MODEL_TEMPLATE_DEFAULTS = {
  "openai-compatible": {
    template: "openai-compatible",
    provider: "openai-compatible",
    modelId: "",
    modelName: "",
    baseUrl: "",
    api: "openai-responses",
    apiKey: "OPENAI_API_KEY"
  },
  ollama: {
    template: "ollama",
    provider: "ollama",
    modelId: "qwen2.5-coder:7b",
    modelName: "",
    baseUrl: "http://localhost:11434/v1",
    api: "openai-completions",
    apiKey: "ollama"
  }
};

function insertAtCursor(text, insert) {
  const start = text.selectionStart ?? 0;
  const end = text.selectionEnd ?? 0;
  const value = text.value ?? "";
  return {
    nextValue: `${value.slice(0, start)}${insert}${value.slice(end)}`,
    nextCursor: start + insert.length
  };
}

function makeId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function configuredPositiveNumber(key, fallback) {
  return positiveInteger(localStorage.getItem(key), fallback);
}

function storageLimits() {
  return {
    terminalPreviewChars: configuredPositiveNumber(TERMINAL_PREVIEW_CHARS_STORAGE_KEY, DEFAULT_STORAGE_LIMITS.terminalPreviewChars),
    sessionTextPreviewChars: configuredPositiveNumber(SESSION_TEXT_PREVIEW_CHARS_STORAGE_KEY, DEFAULT_STORAGE_LIMITS.sessionTextPreviewChars),
    sessionTurnLimit: configuredPositiveNumber(SESSION_TURN_LIMIT_STORAGE_KEY, DEFAULT_STORAGE_LIMITS.sessionTurnLimit),
    sessionFileRecordLimit: configuredPositiveNumber(SESSION_FILE_RECORD_LIMIT_STORAGE_KEY, DEFAULT_STORAGE_LIMITS.sessionFileRecordLimit)
  };
}

function normalizeBackgroundPiIdleStopMinutes(value) {
  const minutes = Number(value);
  return Number.isFinite(minutes) && minutes >= 0 ? Math.floor(minutes) : DEFAULT_BACKGROUND_PI_IDLE_STOP_MINUTES;
}

function limitTerminalPreview(text) {
  return limitTextValue(text, storageLimits().terminalPreviewChars);
}

function basename(path) {
  return String(path || "项目").split(/[\\/]/).filter(Boolean).pop() || "项目";
}

function quotePath(path) {
  return `"${String(path).replaceAll('"', '\\"')}"`;
}

function buildPromptWithAttachments(text, attachments) {
  const body = String(text || "").trim();
  if (attachments.length === 0) return body;
  const header = body || "请分析以下文件：";
  const paths = attachments.map((item) => `- ${item.token}`).join("\n");
  return `${header}\n\n附加文件路径：\n${paths}`;
}

function titleFromPromptAndAttachments(text, attachments) {
  const body = String(text || "").trim();
  if (body) return body.length > 48 ? `${body.slice(0, 48)}…` : body;
  if (attachments.length === 1) return `分析 ${attachments[0].name}`;
  if (attachments.length > 1) return `分析 ${attachments[0].name} 等 ${attachments.length} 个文件`;
  return "新 Pi 会话";
}

function shouldContinueSession(session) {
  return Boolean(
    session?.first_prompt
    || (Array.isArray(session?.turns) && session.turns.length > 0)
  );
}

function stripAnsiForDetection(text) {
  return String(text || "").replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");
}

function normalizeDetectedPath(rawPath, projectPath = "") {
  let path = String(rawPath || "").trim().replace(/^[-*•]\s*/, "").replace(/^['\"]|['\"]$/g, "");
  path = path.replace(/[),.;，。；：:]+$/g, "");
  if (!path) return "";
  if (/^[a-z]+:\/\//i.test(path)) return "";
  const absolute = /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("/") || path.startsWith("\\\\");
  if (!absolute && projectPath) {
    const sep = projectPath.includes("\\") ? "\\" : "/";
    path = `${projectPath.replace(/[\\/]$/, "")}${sep}${path.replace(/^[\\/]/, "")}`;
  }
  return path;
}

function extractFilePathsFromText(text, projectPath = "", allowExtensionless = false) {
  const clean = stripAnsiForDetection(text);
  const found = new Set();
  const patterns = [
    /"([^"\r\n]+\.[A-Za-z0-9]{1,12})"/g,
    /'([^'\r\n]+\.[A-Za-z0-9]{1,12})'/g,
    /[A-Za-z]:[\\/][^\r\n"'<>|]+?\.[A-Za-z0-9]{1,12}/g,
    /(?:\.{1,2}[\\/])?[\w\u4e00-\u9fa5 .@()\-]+(?:[\\/][\w\u4e00-\u9fa5 .@()\-]+)+\.[A-Za-z0-9]{1,12}/g
  ];

  if (allowExtensionless) {
    patterns.push(
      /"([A-Za-z]:[\\/][^"\r\n<>|]+)"/g,
      /'([A-Za-z]:[\\/][^'\r\n<>|]+)'/g,
      /^[ \t]*([A-Za-z]:[\\/][^\r\n"'<>|]+)[ \t]*$/gm,
      /[：:]\s*([A-Za-z]:[\\/][^\r\n"'<>|]+)/g
    );
  }

  for (const pattern of patterns) {
    for (const match of clean.matchAll(pattern)) {
      const value = normalizeDetectedPath(match[1] || match[0], projectPath);
      if (value) found.add(value);
    }
  }
  return [...found];
}

function fileRecordsFromPaths(paths, source) {
  return [...new Set(paths.filter(Boolean).map(String))].map((path) => ({
    id: makeId("session-file"),
    name: basename(path),
    path,
    source,
    created_at: new Date().toISOString()
  }));
}

function formatModelInfo(model) {
  if (!model) return "";
  const name = String(model.name || model.id || model.model || "").trim();
  const provider = String(model.provider || "").trim();
  if (!name && !provider) return "";
  return provider ? `${name} via ${provider}` : name;
}

function sameModel(left, right) {
  if (!left || !right) return false;
  return String(left.id || left.model || "") === String(right.id || right.model || "")
    && String(left.provider || "") === String(right.provider || "");
}

function sessionModelOptions(session) {
  const list = Array.isArray(session?.available_models) ? session.available_models : [];
  const selected = session?.pending_model || session?.current_model;
  if (!selected || list.some((model) => sameModel(model, selected))) return list;
  return [selected, ...list];
}

function normalizeCenterView(value) {
  return value === "terminal" ? "terminal" : "session";
}

function latestTurnIndex(turns) {
  if (!Array.isArray(turns) || turns.length === 0) return -1;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    if (turns[index]?.status === "running") return index;
  }
  return turns.length - 1;
}

function latestRunningTurnIndex(turns) {
  if (!Array.isArray(turns)) return -1;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    if (turns[index]?.status === "running") return index;
  }
  return -1;
}

function createTimelineTurn({ userText, finalPrompt, attachments }) {
  const now = new Date().toISOString();
  return {
    id: makeId("turn"),
    status: "running",
    created_at: now,
    updated_at: now,
    items: [
      {
        id: makeId("item"),
        type: "user_message",
        text: userText,
        final_prompt: finalPrompt,
        attachments,
        status: "completed",
        created_at: now,
        updated_at: now
      },
      {
        id: makeId("item"),
        type: "progress",
        title: "任务已发送给 Pi",
        detail: "等待 AI 分析并返回结果。",
        status: "running",
        created_at: now,
        updated_at: now
      },
      {
        id: makeId("item"),
        type: "assistant_message",
        text: "",
        status: "running",
        created_at: now,
        updated_at: now
      }
    ]
  };
}

function updateLatestTurnStatus(turns, status, now, errorDetail = "") {
  const list = Array.isArray(turns) ? turns : [];
  const index = latestRunningTurnIndex(list);
  if (index < 0) return list;
  return list.map((turn, turnIndex) => {
    if (turnIndex !== index) return turn;
    const nextItems = (Array.isArray(turn.items) ? turn.items : []).map((item) => {
      if (item.type === "progress") {
        return { ...item, status, detail: status === "completed" ? "AI 已完成本轮任务。" : item.detail, updated_at: now };
      }
      if (item.type === "assistant_message" && item.status === "running") {
        return { ...item, status, updated_at: now };
      }
      return item;
    });
    const errorItems = status === "failed" && errorDetail ? [{
      id: makeId("item"),
      type: "error",
      title: "执行失败",
      detail: errorDetail,
      status: "failed",
      created_at: now,
      updated_at: now
    }] : [];
    return { ...turn, status, items: [...nextItems, ...errorItems], updated_at: now };
  });
}

function appendFileItemToLatestTurn(turns, kind, files, now) {
  const list = Array.isArray(turns) ? turns : [];
  const index = latestTurnIndex(list);
  if (index < 0 || !Array.isArray(files) || files.length === 0) return list;
  const type = kind === "output" ? "file_output" : "file_reference";
  return list.map((turn, turnIndex) => turnIndex === index ? {
    ...turn,
    items: [
      ...(Array.isArray(turn.items) ? turn.items : []),
      {
        id: makeId("item"),
        type,
        title: kind === "output" ? "AI 输出文件" : "AI 参考文件",
        files,
        status: "completed",
        created_at: now,
        updated_at: now
      }
    ],
    updated_at: now
  } : turn);
}

let debugLogContext = { enabled: false, workdir: "" };

function setDebugLogContext(context) {
  debugLogContext = {
    enabled: Boolean(context?.enabled),
    workdir: String(context?.workdir || "")
  };
}

function debugLog(message, data = undefined) {
  if (!debugLogContext.enabled) return;
  const suffix = data === undefined ? "" : ` ${JSON.stringify(data, (_key, value) => typeof value === "string" && value.length > 300 ? `${value.slice(0, 300)}…` : value)}`;
  invoke("append_debug_log", { source: "frontend", message: `${message}${suffix}`, workdir: debugLogContext.workdir || null }).catch(() => {});
}

function loadProjects() {
  try {
    const raw = localStorage.getItem(PROJECTS_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return normalizeStoredProjects(Array.isArray(parsed) ? parsed : [], storageLimits());
  } catch {
    return [];
  }
}

function relativeTime(value) {
  if (!value) return "";
  const diff = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(diff)) return "";
  const min = Math.max(0, Math.floor(diff / 60000));
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours} 时`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} 天`;
  return `${Math.floor(days / 7)} 周`;
}

function ProjectPanel({ projects, activeProjectId, activeSessionId, piSessionStatus, onAddProject, onNewSession, onSelectSession, onToggleProject, onStopSessionPi, onArchiveProject, onArchiveSession, onRenameSession, onOpenProjectInExplorer }) {
  const [menu, setMenu] = useState(null);
  const [editing, setEditing] = useState(null);
  const [draftTitle, setDraftTitle] = useState("");
  const visibleProjects = projects.filter((project) => !project.archived);

  useEffect(() => {
    const close = () => setMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", close);
    };
  }, []);

  function openMenu(event, payload) {
    event.preventDefault();
    event.stopPropagation();
    setMenu({ x: event.clientX, y: event.clientY, ...payload });
  }

  function startRename(projectId, session) {
    setMenu(null);
    setEditing({ projectId, sessionId: session.id, originalTitle: session.title });
    setDraftTitle(session.title);
  }

  function cancelRename() {
    setEditing(null);
    setDraftTitle("");
  }

  function confirmRename() {
    if (!editing) return;
    const nextTitle = draftTitle.trim();
    if (!nextTitle) {
      cancelRename();
      return;
    }
    try {
      const ok = onRenameSession(editing.projectId, editing.sessionId, nextTitle);
      if (ok === false) throw new Error("rename failed");
      cancelRename();
    } catch {
      setDraftTitle(editing.originalTitle);
      cancelRename();
    }
  }

  return (
    <section className="panel projects-panel">
      <div className="panel-title-row">
        <h3><FolderOpen size={16}/> 项目</h3>
        <button className="icon" title="添加项目目录" onClick={onAddProject}><Plus size={15}/></button>
      </div>
      <div className="project-list">
        {visibleProjects.length === 0 && <div className="empty">暂无项目。点击 + 选择一个目录。</div>}
        {visibleProjects.map((project) => (
          <div className="project-group" key={project.id}>
            <div
              className={`project-heading ${activeProjectId === project.id ? "active" : ""}`}
              title={`${project.path}\n左键展开/收起，右键归档项目`}
              onClick={() => onToggleProject(project.id)}
              onContextMenu={(event) => openMenu(event, { type: "project", projectId: project.id })}
            >
              <Folder size={15}/>
              <span>{project.collapsed ? "▸" : "▾"} {project.name}</span>
              <button className="icon project-add-session" title="新建 Pi 会话" onClick={(event) => { event.stopPropagation(); onNewSession(project.id); }}><Plus size={13}/></button>
            </div>
            {!project.collapsed && (
              <div className="project-sessions">
                {(() => {
                  const visibleSessions = (project.sessions || []).filter((session) => !session.archived);
                  if (visibleSessions.length === 0) return <div className="project-empty-session">暂无 Pi 会话</div>;
                  return visibleSessions.map((session) => {
                  const isEditing = editing?.sessionId === session.id;
                  return (
                    <div
                      key={session.id}
                      className={`project-session ${activeSessionId === session.id ? "active" : ""}`}
                      onClick={() => !isEditing && onSelectSession(project.id, session.id)}
                      onContextMenu={(event) => openMenu(event, { type: "session", projectId: project.id, session })}
                      title={`${session.title}\n右键重命名/归档`}
                    >
                      {isEditing ? (
                        <input
                          className="project-session-rename-input"
                          value={draftTitle}
                          autoFocus
                          onClick={(event) => event.stopPropagation()}
                          onChange={(event) => setDraftTitle(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              event.preventDefault();
                              confirmRename();
                            } else if (event.key === "Escape") {
                              event.preventDefault();
                              cancelRename();
                            }
                          }}
                        />
                      ) : (
                        <>
                          <i className={`session-state-dot ${piSessionStatus?.[session.id]?.processing ? "processing" : piSessionStatus?.[session.id]?.running ? "running" : "stopped"}`} />
                          <span>{session.title}</span>
                          <small>{relativeTime(session.updated_at || session.created_at)}</small>
                        </>
                      )}
                    </div>
                  );
                  });
                })()}
              </div>
            )}
          </div>
        ))}
      </div>
      {menu && (
        <div className="project-context-menu" style={{ left: menu.x, top: menu.y }} onClick={(event) => event.stopPropagation()}>
          {menu.type === "project" && <button onClick={() => {
            setMenu(null);
            onOpenProjectInExplorer(menu.projectId);
          }}>在资源管理器打开</button>}
          {menu.type === "session" && <button onClick={() => startRename(menu.projectId, menu.session)}>重命名</button>}
          {menu.type === "session" && (piSessionStatus?.[menu.session.id]?.running || piSessionStatus?.[menu.session.id]?.starting) && <button onClick={() => {
            setMenu(null);
            Promise.resolve(onStopSessionPi(menu.session.id)).catch(() => {});
          }}>关闭 Pi</button>}
          <button onClick={() => {
            setMenu(null);
            if (menu.type === "project") Promise.resolve(onArchiveProject(menu.projectId)).catch(() => {});
            else Promise.resolve(onArchiveSession(menu.projectId, menu.session.id)).catch(() => {});
          }}>{menu.type === "project" ? "归档项目" : "归档会话"}</button>
        </div>
      )}
    </section>
  );
}

function isDirectoryNode(node) {
  return Boolean(node?.is_dir ?? node?.isDir);
}

function nodeMatchesDirectorySearch(node, query) {
  const keyword = String(query || "").trim().toLowerCase();
  if (!keyword) return true;
  return [node?.name, node?.path].some((value) => String(value || "").toLowerCase().includes(keyword));
}

function filterDirectoryTreeNode(node, query) {
  const keyword = String(query || "").trim().toLowerCase();
  if (!node) return { node: null, matchCount: 0 };
  if (!keyword) return { node, matchCount: 0 };

  let matchCount = 0;
  function walk(current) {
    const children = Array.isArray(current.children) ? current.children : [];
    const filteredChildren = children.map(walk).filter(Boolean);
    const selfMatch = nodeMatchesDirectorySearch(current, keyword);
    if (!selfMatch && filteredChildren.length === 0) return null;
    if (selfMatch && !current.omitted) matchCount += 1;
    return { ...current, children: filteredChildren };
  }

  return { node: walk(node), matchCount };
}

function collectDirectorySearchExpandedPaths(node) {
  const paths = new Set();
  function walk(current) {
    if (!current) return;
    if (isDirectoryNode(current)) paths.add(current.path);
    (current.children || []).forEach(walk);
  }
  walk(node);
  return paths;
}

function replaceDirectoryTreeNode(node, targetPath, updater) {
  if (!node) return node;
  if (node.path === targetPath) return updater(node);
  const children = Array.isArray(node.children) ? node.children : [];
  let changed = false;
  const nextChildren = children.map((child) => {
    const nextChild = replaceDirectoryTreeNode(child, targetPath, updater);
    if (nextChild !== child) changed = true;
    return nextChild;
  });
  return changed ? { ...node, children: nextChildren } : node;
}

function HighlightText({ text, query }) {
  const value = String(text || "");
  const keyword = String(query || "").trim();
  if (!keyword) return value;
  const index = value.toLowerCase().indexOf(keyword.toLowerCase());
  if (index < 0) return value;
  return <>{value.slice(0, index)}<mark>{value.slice(index, index + keyword.length)}</mark>{value.slice(index + keyword.length)}</>;
}

function DirectoryTreeNodeView({ node, depth = 0, expandedPaths, loadingPaths = new Set(), searchText = "", onToggleDirectory, onOpenFile }) {
  if (!node) return null;
  const isDir = isDirectoryNode(node);
  const children = Array.isArray(node.children) ? node.children : [];
  const loading = loadingPaths.has(node.path);
  const expanded = expandedPaths.has(node.path);
  const canExpand = isDir && !node.omitted && (children.length > 0 || loading || node.has_more || node.children_loaded === false);

  function handleClick() {
    if (canExpand) onToggleDirectory(node);
  }

  function handleDoubleClick(event) {
    event.stopPropagation();
    if (!isDir && !node.omitted) onOpenFile(node.path);
  }

  function handleDragStart(event) {
    if (isDir || node.omitted) return;
    event.dataTransfer.effectAllowed = "copy";
    event.dataTransfer.setData("application/x-pi-file-path", node.path);
    event.dataTransfer.setData("text/plain", quotePath(node.path));
  }

  return (
    <>
      <div
        className={`directory-tree-row ${isDir ? "dir" : "file"} ${node.omitted ? "omitted" : ""}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        title={isDir ? node.path : `${node.path}\n双击打开，或拖入下方会话框插入路径`}
        draggable={!isDir && !node.omitted}
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
        onDragStart={handleDragStart}
      >
        <span className="directory-tree-toggle">{isDir ? (loading ? "…" : (canExpand ? (expanded ? "▾" : "▸") : "•")) : ""}</span>
        {isDir ? <Folder size={14}/> : <File size={14}/>}
        <span className="directory-tree-name"><HighlightText text={node.name} query={searchText}/>{isDir ? "/" : ""}</span>
        {node.omitted && <em>已省略</em>}
        {loading && <em>加载中</em>}
      </div>
      {isDir && expanded && children.map((child) => (
        <DirectoryTreeNodeView
          key={`${child.path}-${child.name}`}
          node={child}
          depth={depth + 1}
          expandedPaths={expandedPaths}
          loadingPaths={loadingPaths}
          searchText={searchText}
          onToggleDirectory={onToggleDirectory}
          onOpenFile={onOpenFile}
        />
      ))}
    </>
  );
}

function SessionFilesSection({ title, files, emptyText, onOpenFile, onOpenDirectory }) {
  const [expanded, setExpanded] = useState(true);
  const fileList = files || [];

  return (
    <div className="session-files-section">
      <button
        type="button"
        className="session-files-section-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <span className="session-files-section-label">
          {expanded ? <ChevronDown size={14}/> : <ChevronRight size={14}/>}
          <strong>{title}</strong>
        </span>
        <small>{fileList.length} 个</small>
      </button>
      {expanded && (
        fileList.length === 0
          ? <div className="session-files-empty">{emptyText}</div>
          : (
            <div className="session-files-list">
              {fileList.map((file) => (
                <button
                  key={`${file.path}-${file.source}`}
                  className="session-file-item"
                  title={`${file.path}\n左键打开文件，右键打开所在目录`}
                  onClick={() => onOpenFile(file)}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    onOpenDirectory(file);
                  }}
                >
                  <File size={14}/>
                  <span>{file.name || basename(file.path)}</span>
                  <small>{file.source || ""}</small>
                </button>
              ))}
            </div>
          )
      )}
    </div>
  );
}

function PiSetupPanel({
  environment,
  checking,
  installing,
  modelDraft,
  onModelDraftChange,
  onCheck,
  onInstall,
  onSaveModel,
  onOpenDebugLog,
  onClose
}) {
  const ready = Boolean(environment?.ready);
  const issues = Array.isArray(environment?.issues) ? environment.issues : [];
  const modelConfigPath = environment?.modelsConfig || "";
  const command = environment?.command || DEFAULT_COMMAND;

  function updateDraft(patch) {
    onModelDraftChange({ ...modelDraft, ...patch });
  }

  function changeTemplate(template) {
    onModelDraftChange({ ...MODEL_TEMPLATE_DEFAULTS[template] });
  }

  return (
    <div className="pi-setup-view">
      <div className="pi-setup-card">
        <div className="pi-setup-header">
          <div>
            <h2>Pi 环境设置</h2>
            <p>{ready ? "Pi 环境已就绪，可以正常发送任务。" : "完成 Pi 安装和模型配置后即可发送任务。"}</p>
          </div>
          {ready && <button className="icon" title="关闭环境设置" onClick={onClose}><X size={15}/></button>}
        </div>

        <div className="pi-setup-status-grid">
          <div className={`pi-setup-status ${environment?.installed ? "ok" : "danger"}`}>
            <strong>Pi CLI</strong>
            <span>{environment?.installed ? environment?.version || "已安装" : "未检测到"}</span>
            <small>{command}</small>
          </div>
          <div className={`pi-setup-status ${environment?.hasModels || environment?.hasAuth ? "ok" : "danger"}`}>
            <strong>模型配置</strong>
            <span>{environment?.hasModels ? `${environment?.modelCount || 0} 个模型` : (environment?.hasAuth ? "已有认证信息" : "未配置")}</span>
            <small>{modelConfigPath || "models.json 未创建"}</small>
          </div>
        </div>

        {issues.length > 0 && (
          <div className="pi-setup-issues">
            {issues.map((issue) => <div key={issue.code || issue.message}>{issue.message || String(issue)}</div>)}
          </div>
        )}

        <div className="pi-setup-actions">
          <button onClick={onInstall} disabled={installing}>
            {installing ? "正在安装..." : "安装 Pi"}
          </button>
          <button onClick={onCheck} disabled={checking}>
            <RefreshCw size={14}/> {checking ? "检测中..." : "重新检测"}
          </button>
          <button onClick={onOpenDebugLog}><FileText size={14}/> 调试日志</button>
        </div>

        <div className="pi-setup-form">
          <div className="pi-setup-form-head">
            <strong>配置模型</strong>
            <small>写入 ~/.pi/agent/models.json 和当前项目默认模型</small>
          </div>
          <div className="pi-setup-form-grid">
            <label>
              模板
              <select value={modelDraft.template} onChange={(event) => changeTemplate(event.target.value)}>
                <option value="openai-compatible">OpenAI-compatible</option>
                <option value="ollama">Ollama</option>
              </select>
            </label>
            <label>
              Provider
              <input value={modelDraft.provider} onChange={(event) => updateDraft({ provider: event.target.value })}/>
            </label>
            <label>
              模型 ID
              <input value={modelDraft.modelId} onChange={(event) => updateDraft({ modelId: event.target.value })} placeholder="例如 gpt-4.1 或 qwen2.5-coder:7b"/>
            </label>
            <label>
              显示名称
              <input value={modelDraft.modelName} onChange={(event) => updateDraft({ modelName: event.target.value })} placeholder="可选"/>
            </label>
            <label>
              Base URL
              <input value={modelDraft.baseUrl} onChange={(event) => updateDraft({ baseUrl: event.target.value })} placeholder="例如 https://api.openai.com/v1"/>
            </label>
            <label>
              API
              <input value={modelDraft.api} onChange={(event) => updateDraft({ api: event.target.value })}/>
            </label>
            <label className="pi-setup-form-wide">
              API Key / 环境变量名
              <input value={modelDraft.apiKey} onChange={(event) => updateDraft({ apiKey: event.target.value })} placeholder="例如 OPENAI_API_KEY 或 sk-..."/>
            </label>
          </div>
          <div className="pi-setup-actions">
            <button className="primary" onClick={onSaveModel}>写入模型配置</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function RightToolPanel({
  activeProject,
  activeSession,
  toolListCollapsed,
  directoryTreeOpen,
  sessionFilesOpen,
  directoryTree,
  directoryTreeLoading,
  directoryTreeError,
  expandedDirectoryPaths,
  directoryTreeNodeLoadingPaths,
  directoryTreeSearch,
  onDirectoryTreeSearchChange,
  onToggleToolList,
  onToggleDirectoryTree,
  onToggleSessionFiles,
  onRefreshDirectoryTree,
  onToggleDirectoryNode,
  onOpenDirectoryFile,
  onOpenSessionFile,
  onOpenSessionFileDirectory
}) {
  const searchText = String(directoryTreeSearch || "");
  const filteredTree = filterDirectoryTreeNode(directoryTree?.tree, searchText);
  const effectiveExpandedPaths = searchText.trim()
    ? collectDirectorySearchExpandedPaths(filteredTree.node)
    : expandedDirectoryPaths;

  return (
    <section className="panel tool-panel">
      <div className="panel-title-row tool-panel-title">
        <h3><FolderTree size={16}/> 工具</h3>
        <button className="icon" title={toolListCollapsed ? "展开工具按钮" : "收起工具按钮"} onClick={onToggleToolList}>
          {toolListCollapsed ? <ChevronRight size={15}/> : <ChevronDown size={15}/>}
        </button>
      </div>
      {!toolListCollapsed && (
        <div className="tool-button-list">
          <button className={directoryTreeOpen ? "primary" : ""} onClick={onToggleDirectoryTree}>
            <FolderTree size={15}/> 目录树
          </button>
          <button className={sessionFilesOpen ? "primary" : ""} onClick={onToggleSessionFiles}>
            <File size={15}/> 会话文件
          </button>
        </div>
      )}
      {sessionFilesOpen && <div className="tool-content session-files-card">
        <div className="directory-tree-header">
          <div>
            <strong>当前会话文件</strong>
            <small>{activeSession?.title || "未选择会话"}</small>
          </div>
        </div>
        <SessionFilesSection
          title="AI 参考文件"
          files={activeSession?.referenced_files || []}
          emptyText="暂无参考文件。拖入文件、输入路径或 AI 读取文件后会显示。"
          onOpenFile={onOpenSessionFile}
          onOpenDirectory={onOpenSessionFileDirectory}
        />
        <SessionFilesSection
          title="AI 输出文件"
          files={activeSession?.output_files || []}
          emptyText="暂无输出文件。AI 写入/修改文件后会自动识别。"
          onOpenFile={onOpenSessionFile}
          onOpenDirectory={onOpenSessionFileDirectory}
        />
      </div>}
      {directoryTreeOpen && (
        <div className="tool-content directory-tree-card">
          <div className="directory-tree-header">
            <div>
              <strong>{activeProject?.name || "未选择项目"}</strong>
              <small>{activeProject?.path || "请先在左侧选择一个项目"}</small>
            </div>
            <button className="icon" title="刷新目录树" disabled={!activeProject?.path || directoryTreeLoading} onClick={onRefreshDirectoryTree}>
              <RefreshCw size={14}/>
            </button>
          </div>
          <div className="directory-tree-search">
            <div className="directory-tree-search-row">
              <input
                value={searchText}
                onChange={(event) => onDirectoryTreeSearchChange(event.target.value)}
                placeholder="搜索文件或目录..."
                disabled={!directoryTree?.tree || directoryTreeLoading}
              />
              {searchText && <button type="button" onClick={() => onDirectoryTreeSearchChange("")}>清空</button>}
            </div>
            <div className="directory-tree-search-meta">
              {searchText.trim() ? `找到 ${filteredTree.matchCount} 项` : "输入关键词可按文件名或路径快速过滤"}
            </div>
          </div>
          {directoryTreeLoading && <div className="empty">正在读取目录树…</div>}
          {!directoryTreeLoading && directoryTreeError && <div className="empty danger-text">{directoryTreeError}</div>}
          {!directoryTreeLoading && !directoryTreeError && directoryTree?.tree && filteredTree.node && (
            <div className="directory-tree-output" role="tree">
              <DirectoryTreeNodeView
                node={filteredTree.node}
                expandedPaths={effectiveExpandedPaths}
                loadingPaths={directoryTreeNodeLoadingPaths}
                searchText={searchText}
                onToggleDirectory={onToggleDirectoryNode}
                onOpenFile={onOpenDirectoryFile}
              />
            </div>
          )}
          {!directoryTreeLoading && !directoryTreeError && directoryTree?.tree && !filteredTree.node && (
            <div className="empty">未找到匹配文件或目录</div>
          )}
          {!directoryTreeLoading && !directoryTreeError && directoryTree?.truncated && (
            <div className="directory-tree-note">目录按需加载，展开目录时读取子项。单层条目过多时会按配置限制显示。</div>
          )}
        </div>
      )}
    </section>
  );
}

export default function App() {
  const [status, setStatus] = useState("未启动");
  const [clearTerminalSignal, setClearTerminalSignal] = useState(0);
  const [terminalReplaySignal, setTerminalReplaySignal] = useState(0);
  const [terminalReplayContent, setTerminalReplayContent] = useState("");
  const [centerView, setCenterView] = useState(() => normalizeCenterView(localStorage.getItem(CENTER_VIEW_STORAGE_KEY)));
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [piSessionStatus, setPiSessionStatus] = useState({});
  const [command, setCommand] = useState("");
  const [attachments, setAttachments] = useState([]);
  const [toolListCollapsed, setToolListCollapsed] = useState(false);
  const [directoryTreeOpen, setDirectoryTreeOpen] = useState(false);
  const [sessionFilesOpen, setSessionFilesOpen] = useState(false);
  const [directoryTree, setDirectoryTree] = useState(null);
  const [expandedDirectoryPaths, setExpandedDirectoryPaths] = useState(() => new Set());
  const [directoryTreeNodeLoadingPaths, setDirectoryTreeNodeLoadingPaths] = useState(() => new Set());
  const [directoryTreeSearch, setDirectoryTreeSearch] = useState("");
  const [directoryTreeLoading, setDirectoryTreeLoading] = useState(false);
  const [directoryTreeError, setDirectoryTreeError] = useState("");
  const [workdir, setWorkdir] = useState(localStorage.getItem("workdir") || "");
  const [debugLogEnabled, setDebugLogEnabled] = useState(false);
  const [piEnvironment, setPiEnvironment] = useState(null);
  const [piEnvironmentChecking, setPiEnvironmentChecking] = useState(false);
  const [piSetupOpen, setPiSetupOpen] = useState(false);
  const [piInstalling, setPiInstalling] = useState(false);
  const [modelTemplateDraft, setModelTemplateDraft] = useState(() => ({ ...MODEL_TEMPLATE_DEFAULTS["openai-compatible"] }));
  const [projects, setProjects] = useState(() => loadProjects());
  const [activeProjectId, setActiveProjectId] = useState(null);
  const [activeProjectSessionId, setActiveProjectSessionId] = useState(null);

  const inputRef = useRef(null);
  const outputBufferRef = useRef("");
  const outputIdleTimersRef = useRef({});
  const startingSessionsRef = useRef(new Set());
  const sessionWarmupTimersRef = useRef({});
  const pendingPiInputsRef = useRef({});
  const piEnvironmentCacheRef = useRef({});
  const persistOutputTimerRef = useRef(null);
  const projectsRenderTimerRef = useRef(null);
  const fileEventSeenRef = useRef(new Set());
  const projectsRef = useRef(projects);
  const activeProjectIdRef = useRef(activeProjectId);
  const activeProjectSessionIdRef = useRef(activeProjectSessionId);
  const piSessionStatusRef = useRef(piSessionStatus);
  const backgroundPiIdleStopMinutesRef = useRef(DEFAULT_BACKGROUND_PI_IDLE_STOP_MINUTES);
  const launchHandledRef = useRef(false);
  const legacyPiCommandRef = useRef(localStorage.getItem("piCommand") || DEFAULT_COMMAND);

  useEffect(() => { projectsRef.current = projects; }, [projects]);
  useEffect(() => { activeProjectIdRef.current = activeProjectId; }, [activeProjectId]);
  useEffect(() => { activeProjectSessionIdRef.current = activeProjectSessionId; }, [activeProjectSessionId]);
  useEffect(() => { piSessionStatusRef.current = piSessionStatus; }, [piSessionStatus]);

  const activeProject = useMemo(() => projects.find((p) => p.id === activeProjectId), [projects, activeProjectId]);
  const activeProjectSession = useMemo(
    () => activeProject?.sessions?.find((s) => s.id === activeProjectSessionId),
    [activeProject, activeProjectSessionId]
  );
  const isProcessing = Boolean(activeProjectSessionId && piSessionStatus[activeProjectSessionId]?.processing);
  const activeRuntimeModel = activeProjectSessionId ? piSessionStatus[activeProjectSessionId]?.model : null;
  const activePendingModel = activeProjectSession?.pending_model || null;
  const activeModelLabel = useMemo(
    () => formatModelInfo(activeRuntimeModel || activePendingModel || activeProjectSession?.current_model),
    [activeRuntimeModel, activePendingModel, activeProjectSession?.current_model]
  );
  const activeModelPending = Boolean(activePendingModel && !activeRuntimeModel);
  const piEnvironmentReady = Boolean(piEnvironment?.ready);
  const showPiSetupPanel = piSetupOpen || (piEnvironment && !piEnvironment.ready);

  useEffect(() => {
    const projectPath = activeProject?.path || workdir || "";
    let cancelled = false;
    const timer = window.setTimeout(() => {
      invoke("ensure_pi_ide_config", { workdir: projectPath || null, legacyCommand: legacyPiCommandRef.current }).then((config) => {
        if (cancelled) return;
        const enabled = Boolean(config?.debugEnabled ?? config?.enabled);
        backgroundPiIdleStopMinutesRef.current = normalizeBackgroundPiIdleStopMinutes(config?.backgroundIdleStopMinutes);
        setDebugLogEnabled(enabled);
        setDebugLogContext({ enabled, workdir: projectPath });
      }).catch(() => {
        if (cancelled) return;
        backgroundPiIdleStopMinutesRef.current = DEFAULT_BACKGROUND_PI_IDLE_STOP_MINUTES;
        setDebugLogEnabled(false);
        setDebugLogContext({ enabled: false, workdir: projectPath });
      });
    }, 800);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [activeProject?.path, workdir]);

  function replayTerminalTail(sessionId, fallbackOutput = "") {
    const fallback = String(fallbackOutput || "");
    setTerminalReplayContent(fallback);
    setTerminalReplaySignal((value) => value + 1);
    if (!sessionId) return;
    invoke("read_terminal_log_tail", { sessionId }).then((content) => {
      if (activeProjectSessionIdRef.current !== sessionId) return;
      const nextContent = String(content || fallback);
      if (nextContent === fallback) return;
      setTerminalReplayContent(nextContent);
      setTerminalReplaySignal((value) => value + 1);
      debugLog("terminal replay tail loaded", { sessionId, bytes: nextContent.length });
    }).catch(() => {});
  }

  useEffect(() => {
    localStorage.setItem(CENTER_VIEW_STORAGE_KEY, centerView);
  }, [centerView]);

  useEffect(() => {
    if (centerView !== "terminal") return;
    replayTerminalTail(activeProjectSessionId, activeProjectSession?.output || "");
  }, [centerView, activeProjectSessionId]);

  const loadDirectoryTree = useCallback(async (projectPath = activeProject?.path) => {
    if (!projectPath) {
      setDirectoryTree(null);
      setExpandedDirectoryPaths(new Set());
      setDirectoryTreeNodeLoadingPaths(new Set());
      setDirectoryTreeError("请先在左侧选择一个项目");
      return;
    }
    setDirectoryTreeLoading(true);
    setDirectoryTreeError("");
    setDirectoryTreeNodeLoadingPaths(new Set());
    try {
      const result = await invoke("get_directory_tree", { path: projectPath });
      setDirectoryTree(result);
      setExpandedDirectoryPaths(new Set());
    } catch (error) {
      setDirectoryTree(null);
      setExpandedDirectoryPaths(new Set());
      setDirectoryTreeNodeLoadingPaths(new Set());
      setDirectoryTreeError(String(error));
    } finally {
      setDirectoryTreeLoading(false);
    }
  }, [activeProject?.path]);

  useEffect(() => {
    setDirectoryTreeOpen(false);
    setDirectoryTree(null);
    setExpandedDirectoryPaths(new Set());
    setDirectoryTreeNodeLoadingPaths(new Set());
    setDirectoryTreeSearch("");
    setDirectoryTreeError("");
  }, [activeProject?.path]);

  function handleDirectoryTreeToolClick() {
    if (directoryTreeOpen) {
      setDirectoryTreeOpen(false);
      return;
    }
    setDirectoryTreeOpen(true);
    loadDirectoryTree(activeProject?.path).catch((error) => setDirectoryTreeError(String(error)));
  }

  async function loadDirectoryNodeChildren(path) {
    if (!activeProject?.path || !path) return;
    setDirectoryTreeNodeLoadingPaths((prev) => new Set(prev).add(path));
    try {
      const result = await invoke("get_directory_children", { projectRoot: activeProject.path, path });
      setDirectoryTree((prev) => {
        if (!prev?.tree) return prev;
        return {
          ...prev,
          truncated: Boolean(prev.truncated || result?.truncated),
          tree: replaceDirectoryTreeNode(prev.tree, result.path || path, (node) => ({
            ...node,
            children: result?.children || [],
            children_loaded: true,
            has_more: Boolean(result?.truncated)
          }))
        };
      });
    } catch (error) {
      setDirectoryTreeError(String(error));
    } finally {
      setDirectoryTreeNodeLoadingPaths((prev) => {
        const next = new Set(prev);
        next.delete(path);
        return next;
      });
    }
  }

  function toggleDirectoryNode(node) {
    const path = node?.path;
    if (!path) return;
    const shouldLoadChildren = isDirectoryNode(node) && !node.omitted && node.children_loaded === false;
    setExpandedDirectoryPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
    if (!expandedDirectoryPaths.has(path) && shouldLoadChildren && !directoryTreeNodeLoadingPaths.has(path)) {
      loadDirectoryNodeChildren(path);
    }
  }

  async function openDirectoryFile(path) {
    await invoke("open_file_with_default_app", { path });
    setStatus(`已打开文件：${basename(path)}`);
  }

  async function openSessionFile(file) {
    await invoke("open_file_with_default_app", { path: file.path });
    setStatus(`已打开文件：${file.name || basename(file.path)}`);
  }

  async function openSessionFileDirectory(file) {
    await invoke("open_path_in_file_manager", { path: file.path });
    setStatus(`已打开所在目录：${file.name || basename(file.path)}`);
  }

  async function openDebugLog() {
    try {
      const path = await invoke("get_debug_log_path");
      debugLog("open debug log", { path });
      await invoke("open_path_in_file_manager", { path });
      setStatus(`已打开调试日志目录：${path}`);
    } catch (error) {
      debugLog("open debug log failed", { error: String(error) });
      setStatus(`打开调试日志失败：${String(error)}`);
    }
  }

  const checkPiEnvironment = useCallback(async (projectPath = activeProject?.path || workdir, { showStatus = false, force = false } = {}) => {
    const cacheKey = projectPath || "__global__";
    const cached = piEnvironmentCacheRef.current[cacheKey];
    if (!force && cached && Date.now() - cached.checkedAt < 5 * 60 * 1000) {
      setPiEnvironment(cached.result);
      if (!cached.result?.ready) setPiSetupOpen(true);
      return cached.result;
    }

    setPiEnvironmentChecking(true);
    try {
      const result = await invoke("check_pi_environment", {
        workdir: projectPath || null,
        legacyCommand: legacyPiCommandRef.current
      });
      piEnvironmentCacheRef.current[cacheKey] = { result, checkedAt: Date.now() };
      setPiEnvironment(result);
      if (!result?.ready) {
        setPiSetupOpen(true);
        if (showStatus) setStatus("Pi 环境未就绪，请先完成安装或模型配置");
      } else if (showStatus) {
        setStatus("Pi 环境已就绪");
      }
      return result;
    } catch (error) {
      const result = {
        ready: false,
        installed: false,
        hasModels: false,
        hasAuth: false,
        command: legacyPiCommandRef.current,
        issues: [{ code: "PI_ENV_CHECK_FAILED", message: String(error) }]
      };
      piEnvironmentCacheRef.current[cacheKey] = { result, checkedAt: Date.now() };
      setPiEnvironment(result);
      setPiSetupOpen(true);
      if (showStatus) setStatus(`Pi 环境检测失败：${String(error)}`);
      return result;
    } finally {
      setPiEnvironmentChecking(false);
    }
  }, [activeProject?.path, workdir]);

  async function ensurePiEnvironmentReady(projectPath = activeProject?.path || workdir) {
    if (piEnvironment?.ready) return;
    const result = await checkPiEnvironment(projectPath, { showStatus: true });
    if (!result?.ready) {
      setPiSetupOpen(true);
      throw new Error("Pi 环境未就绪，请先完成安装或模型配置");
    }
  }

  async function installPiCli() {
    if (!window.confirm("将通过 npm 全局安装 @earendil-works/pi-coding-agent。是否继续？")) return;
    setPiInstalling(true);
    try {
      setStatus("正在安装 Pi...");
      await invoke("install_pi_cli");
      setStatus("Pi 安装完成，正在重新检测环境");
      await checkPiEnvironment(activeProject?.path || workdir, { showStatus: true, force: true });
    } catch (error) {
      setStatus(`Pi 安装失败：${String(error)}`);
    } finally {
      setPiInstalling(false);
    }
  }

  async function savePiModelTemplate() {
    try {
      if (!String(modelTemplateDraft.modelId || "").trim()) throw new Error("模型 ID 不能为空");
      if (!String(modelTemplateDraft.provider || "").trim()) throw new Error("Provider 不能为空");
      setStatus("正在写入模型配置...");
      await invoke("save_pi_model_template", {
        workdir: activeProject?.path || workdir || null,
        template: modelTemplateDraft.template,
        provider: modelTemplateDraft.provider,
        modelId: modelTemplateDraft.modelId,
        modelName: modelTemplateDraft.modelName || null,
        baseUrl: modelTemplateDraft.baseUrl || null,
        apiKey: modelTemplateDraft.apiKey || null,
        api: modelTemplateDraft.api || null
      });
      setStatus("模型配置已写入，正在重新检测环境");
      await checkPiEnvironment(activeProject?.path || workdir, { showStatus: true, force: true });
      if (activeProjectSessionIdRef.current) {
        await loadConfiguredModelCandidates(activeProjectSessionIdRef.current).catch(() => {});
      }
    } catch (error) {
      setStatus(`写入模型配置失败：${String(error)}`);
    }
  }

  useEffect(() => {
    setPiEnvironment(null);
    setPiSetupOpen(false);
  }, [activeProject?.path, workdir]);

  function saveProjects(nextProjects) {
    const compactProjects = normalizeStoredProjects(nextProjects, storageLimits());
    projectsRef.current = compactProjects;
    setProjects(compactProjects);
    localStorage.setItem(PROJECTS_STORAGE_KEY, JSON.stringify(compactProjects));
  }

  function getSessionById(sessionId) {
    for (const project of projectsRef.current) {
      const session = (project.sessions || []).find((item) => item.id === sessionId);
      if (session) return { project, session };
    }
    return { project: null, session: null };
  }

  function setSessionRuntimeStatus(sessionId, patch) {
    if (!sessionId) return;
    debugLog("setSessionRuntimeStatus", { sessionId, patch });
    const next = {
      ...piSessionStatusRef.current,
      [sessionId]: { ...(piSessionStatusRef.current[sessionId] || {}), ...patch }
    };
    piSessionStatusRef.current = next;
    setPiSessionStatus(next);
  }

  function touchPiSessionActivity(sessionId, patch = {}) {
    if (!sessionId) return;
    const now = Date.now();
    const isActive = sessionId === activeProjectSessionIdRef.current;
    const current = piSessionStatusRef.current[sessionId] || {};
    setSessionRuntimeStatus(sessionId, {
      ...patch,
      lastActivityAt: now,
      backgroundSinceAt: isActive ? null : current.backgroundSinceAt || now
    });
  }

  function markSessionBackgroundState(previousSessionId, nextSessionId) {
    const now = Date.now();
    if (previousSessionId && previousSessionId !== nextSessionId && piSessionStatusRef.current[previousSessionId]?.running) {
      setSessionRuntimeStatus(previousSessionId, { backgroundSinceAt: now });
    }
    if (nextSessionId && piSessionStatusRef.current[nextSessionId]?.running) {
      setSessionRuntimeStatus(nextSessionId, { backgroundSinceAt: null, lastActivityAt: now });
    }
  }

  function clearSessionIdleTimer(sessionId) {
    const timer = outputIdleTimersRef.current[sessionId];
    if (timer) clearTimeout(timer);
    delete outputIdleTimersRef.current[sessionId];
  }

  function updateSessionById(sessionId, updater, { persist = true } = {}) {
    if (!sessionId) return null;
    let updatedSession = null;
    let changed = false;
    const nextProjects = projectsRef.current.map((project) => ({
      ...project,
      sessions: (project.sessions || []).map((session) => {
        if (session.id !== sessionId) return session;
        const nextSession = updater(session);
        updatedSession = nextSession;
        changed = nextSession !== session;
        return nextSession;
      })
    }));
    if (changed) {
      const compactProjects = normalizeStoredProjects(nextProjects, storageLimits());
      projectsRef.current = compactProjects;
      setProjects(compactProjects);
      if (persist) localStorage.setItem(PROJECTS_STORAGE_KEY, JSON.stringify(compactProjects));
    }
    return updatedSession;
  }

  function persistCurrentSessionOutput() {
    const compactProjects = normalizeStoredProjects(projectsRef.current, storageLimits());
    projectsRef.current = compactProjects;
    localStorage.setItem(PROJECTS_STORAGE_KEY, JSON.stringify(compactProjects));
  }

  function schedulePersistCurrentSessionOutput() {
    if (persistOutputTimerRef.current) clearTimeout(persistOutputTimerRef.current);
    persistOutputTimerRef.current = setTimeout(() => persistCurrentSessionOutput(), 600);
  }

  function scheduleProjectsRenderAndPersist() {
    if (!projectsRenderTimerRef.current) {
      projectsRenderTimerRef.current = setTimeout(() => {
        projectsRenderTimerRef.current = null;
        setProjects(projectsRef.current);
      }, 300);
    }
    schedulePersistCurrentSessionOutput();
  }

  function findProjectBySessionId(sessionId) {
    return projectsRef.current.find((project) => (project.sessions || []).some((session) => session.id === sessionId));
  }

  function addSessionFiles(kind, files, targetSessionId = activeProjectSessionIdRef.current) {
    const sessionId = targetSessionId;
    const project = findProjectBySessionId(sessionId);
    const projectId = project?.id;
    if (!projectId || !sessionId || !Array.isArray(files) || files.length === 0) return;
    const field = kind === "output" ? "output_files" : "referenced_files";
    const now = new Date().toISOString();
    let changed = false;
    const nextProjects = projectsRef.current.map((project) => {
      if (project.id !== projectId) return project;
      return {
        ...project,
        updated_at: now,
        sessions: (project.sessions || []).map((session) => {
          if (session.id !== sessionId) return session;
          const existing = new Set((session[field] || []).map((item) => item.path));
          const additions = files.filter((item) => item?.path && !existing.has(item.path));
          if (additions.length === 0) return session;
          changed = true;
          return {
            ...session,
            [field]: [...(session[field] || []), ...additions],
            turns: appendFileItemToLatestTurn(session.turns, kind, additions, now),
            updated_at: now
          };
        })
      };
    });
    if (changed) saveProjects(nextProjects);
  }

  function addTurnToSession(sessionId, turn) {
    updateSessionById(sessionId, (session) => ({
      ...session,
      turns: [...(Array.isArray(session.turns) ? session.turns : []), turn],
      updated_at: turn.updated_at
    }));
  }

  function markLatestTurnStatus(sessionId, status, errorDetail = "") {
    const now = new Date().toISOString();
    updateSessionById(sessionId, (session) => {
      return {
        ...session,
        turns: updateLatestTurnStatus(session.turns, status, now, errorDetail),
        updated_at: now
      };
    });
  }

  function normalizeModelInfo(model) {
    if (!model) return null;
    const id = String(model.id || model.model || model.name || "").trim();
    const name = String(model.name || model.id || model.model || "").trim();
    if (!id && !name) return null;
    return {
      id,
      name: name || id,
      provider: String(model.provider || "").trim(),
      api: String(model.api || "").trim()
    };
  }

  function updateSessionModel(sessionId, model) {
    const normalized = normalizeModelInfo(model);
    if (!sessionId || !normalized) return;
    setSessionRuntimeStatus(sessionId, { model: normalized });
    updateSessionById(sessionId, (session) => ({
      ...session,
      current_model: normalized,
      pending_model: null,
      updated_at: new Date().toISOString()
    }));
  }

  function updateSessionModels(sessionId, models, currentModel) {
    const normalizedModels = (Array.isArray(models) ? models : []).map(normalizeModelInfo).filter(Boolean);
    const normalizedCurrent = normalizeModelInfo(currentModel);
    updateSessionById(sessionId, (session) => ({
      ...session,
      available_models: normalizedModels,
      current_model: normalizedCurrent || session.current_model,
      updated_at: new Date().toISOString()
    }));
    if (normalizedCurrent) setSessionRuntimeStatus(sessionId, { model: normalizedCurrent });
  }

  function applyPiIdeEvents(events) {
    if (!Array.isArray(events) || events.length === 0) return;
    const bySession = new Map();

    for (const event of events) {
      const targetSessionId = event.ideSessionId || event.ide_session_id || activeProjectSessionIdRef.current;
      if (!targetSessionId) continue;
      const runtime = piSessionStatusRef.current[targetSessionId] || {};
      const eventRunId = event.ideRunId || event.ide_run_id;
      if (eventRunId && runtime.runId && eventRunId !== runtime.runId) continue;
      if (!eventRunId && runtime.runId && event.kind !== "reference" && event.kind !== "output") continue;
      const key = event.id || `${targetSessionId}:${event.kind}:${event.eventType || event.type}:${event.source}:${event.toolCallId}:${event.path}:${event.timestamp}`;
      if (fileEventSeenRef.current.has(key)) continue;
      fileEventSeenRef.current.add(key);

      if (event.kind === "model") {
        touchPiSessionActivity(targetSessionId);
        updateSessionModel(targetSessionId, event.model);
        continue;
      }

      if (event.kind === "models") {
        touchPiSessionActivity(targetSessionId);
        updateSessionModels(targetSessionId, event.models, event.currentModel || event.current_model);
        continue;
      }

      if (event.kind === "model_switch_result") {
        touchPiSessionActivity(targetSessionId);
        if (event.success) {
          updateSessionModel(targetSessionId, event.model);
          setStatus(`已切换模型：${formatModelInfo(event.model)}`);
        } else {
          setStatus(`模型切换失败：${event.error || "未知错误"}`);
          debugLog("model switch failed", { targetSessionId, error: event.error, requested: event.requested });
        }
        continue;
      }

      if (event.kind === "model_error") {
        setStatus(`模型列表获取失败：${event.error || "未知错误"}`);
        debugLog("model list failed", { targetSessionId, error: event.error });
        continue;
      }

      if (event.kind === "timeline") {
        touchPiSessionActivity(targetSessionId);
        debugLog("timeline event", { targetSessionId, eventType: event.eventType, eventRunId, runtimeRunId: runtime.runId });
        if (event.model) updateSessionModel(targetSessionId, event.model);
        const failedEvent = event.eventType === "extension_error" || (event.eventType === "auto_retry_end" && event.success === false);
        if (event.eventType === "agent_start") {
          clearSessionIdleTimer(targetSessionId);
          setSessionRuntimeStatus(targetSessionId, { processing: true });
        }
        updateSessionById(targetSessionId, (session) => ({
          ...session,
          turns: applyPiIdeTimelineEvent(session.turns, event, { makeId }),
          updated_at: event.timestamp || new Date().toISOString()
        }));
        if (event.eventType === "agent_end") {
          debugLog("processing false by agent_end", { targetSessionId });
          clearSessionIdleTimer(targetSessionId);
          setSessionRuntimeStatus(targetSessionId, { processing: false });
          markLatestTurnStatus(targetSessionId, "completed");
        }
        if (failedEvent) {
          debugLog("processing false by failed timeline event", { targetSessionId, eventType: event.eventType });
          clearSessionIdleTimer(targetSessionId);
          setSessionRuntimeStatus(targetSessionId, { processing: false });
          markLatestTurnStatus(targetSessionId, "failed", event.error || event.finalError || event.errorMessage || "Pi 执行失败");
        }
        continue;
      }

      if (!event?.path || !event?.kind) continue;

      const record = {
        id: makeId("session-file"),
        name: event.name || basename(event.path),
        path: event.path,
        source: event.source || "pi-tool",
        confidence: event.confidence || "precise",
        tool_name: event.toolName,
        tool_call_id: event.toolCallId,
        created_at: event.timestamp || new Date().toISOString()
      };

      if (!bySession.has(targetSessionId)) bySession.set(targetSessionId, { referenced: [], output: [] });
      const bucket = bySession.get(targetSessionId);
      if (event.kind === "reference") bucket.referenced.push(record);
      else if (event.kind === "output") bucket.output.push(record);
    }

    for (const [sessionId, bucket] of bySession.entries()) {
      if (bucket.referenced.length) addSessionFiles("referenced", bucket.referenced, sessionId);
      if (bucket.output.length) addSessionFiles("output", bucket.output, sessionId);
    }
  }

  function appendOutputToSession(sessionId, data) {
    if (!sessionId || !data) return;
    debugLog("appendOutputToSession", { sessionId, bytes: data.length, active: activeProjectSessionIdRef.current });
    const now = new Date().toISOString();
    let changed = false;
    const nextProjects = projectsRef.current.map((project) => ({
      ...project,
      sessions: (project.sessions || []).map((session) => {
        if (session.id !== sessionId) return session;
        changed = true;
        const preview = limitTerminalPreview(`${session.output || ""}${data}`);
        return {
          ...session,
          output: preview.text,
          output_truncated: Boolean(session.output_truncated || preview.truncated),
          output_bytes: (Number(session.output_bytes) || 0) + data.length,
          updated_at: now
        };
      })
    }));
    if (!changed) return;
    projectsRef.current = normalizeStoredProjects(nextProjects, storageLimits());
    if (sessionId === activeProjectSessionIdRef.current) {
      outputBufferRef.current = limitTerminalPreview(`${outputBufferRef.current || ""}${data}`).text;
    }
    scheduleProjectsRenderAndPersist();
  }

  useEffect(() => {
    const runningProjectPaths = [...new Set(
      projects.flatMap((project) => (project.sessions || []).some((session) => piSessionStatus[session.id]?.running) ? [project.path] : [])
    )].filter(Boolean);
    if (runningProjectPaths.length === 0) return;

    let cancelled = false;
    const poll = async () => {
      for (const projectPath of runningProjectPaths) {
        try {
          const events = await invoke("load_pi_ide_events", { workdir: projectPath });
          if (!cancelled) applyPiIdeEvents(events);
        } catch (_) {
          // 事件桥扩展尚未生成或 Pi 未写入事件时忽略。
        }
      }
    };
    poll();
    const timer = window.setInterval(poll, 1200);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [projects, piSessionStatus]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const limitMs = backgroundPiIdleStopMinutesRef.current * 60 * 1000;
      if (limitMs <= 0) return;
      const now = Date.now();
      const activeSessionId = activeProjectSessionIdRef.current;
      for (const [sessionId, runtime] of Object.entries(piSessionStatusRef.current)) {
        if (sessionId === activeSessionId) continue;
        if (!runtime?.running || runtime.processing || runtime.starting || runtime.idleStopping) continue;
        const idleStart = Math.max(Number(runtime.lastActivityAt) || 0, Number(runtime.backgroundSinceAt) || 0);
        if (!idleStart || now - idleStart < limitMs) continue;
        stopProjectSessionPi(sessionId, { reason: "idle" }).catch((error) => {
          debugLog("idle stop failed", { sessionId, error: String(error) });
        });
      }
    }, 30000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    setCommand("");
    outputBufferRef.current = "";
    setTerminalReplayContent("");
    setTerminalReplaySignal((value) => value + 1);

    invoke("get_launch_context").then((context) => {
      if (launchHandledRef.current) return;
      launchHandledRef.current = true;
      const projectPath = context?.projectPath || context?.project_path;
      if (projectPath) {
        createOrSelectProjectForPath(projectPath, { createNewSession: true, sessionTitle: "右键启动" });
        setTimeout(() => invoke("ensure_pi_ide_config", { workdir: projectPath, legacyCommand: legacyPiCommandRef.current }).catch(() => {}), 800);
        setStatus(`已载入项目：${basename(projectPath)}`);
      }
    }).catch(() => {});

    const unsubs = [];
    debugLog("app mounted");
    listen("pi-status", (event) => {
      debugLog("pi-status event", event.payload);
      const payload = event.payload;
      const sessionId = payload && typeof payload === "object" ? (payload.sessionId || payload.session_id) : null;
      const text = payload && typeof payload === "object" ? String(payload.status || "") : String(payload || "");
      setStatus(text);
      if (sessionId) {
        const running = text.includes("Pi 已启动") || text.includes("Pi 已经在运行");
        const stopped = text.includes("Pi 已停止") || text.includes("Pi 已退出");
        const previous = piSessionStatusRef.current[sessionId] || {};
        if (stopped) {
          clearSessionIdleTimer(sessionId);
          markLatestTurnStatus(sessionId, "failed", text);
        }
        setSessionRuntimeStatus(sessionId, {
          running: stopped ? false : running || previous.running || false,
          starting: false,
          processing: stopped ? false : previous.processing || false,
          runId: payload.runId || payload.run_id || previous.runId,
          status: text
        });
        if (running && !stopped) {
          flushPendingPiInputs(sessionId).catch((error) => {
            debugLog("flush pending inputs after status failed", { sessionId, error: String(error) });
            setStatus(`发送排队消息失败：${String(error)}`);
          });
        }
      }
    }).then((f) => unsubs.push(f));
    listen("pi-output", (event) => {
      const payload = event.payload || {};
      debugLog("pi-output event", { sessionId: payload.sessionId || payload.session_id, bytes: String(payload.data ?? "").length, active: activeProjectSessionIdRef.current });
      const sessionId = payload.sessionId || payload.session_id;
      const data = String(payload.data ?? "");
      if (sessionId && data) {
        touchPiSessionActivity(sessionId);
        appendOutputToSession(sessionId, data);
      }

      if (!sessionId || !piSessionStatusRef.current[sessionId]?.processing) return;
      clearSessionIdleTimer(sessionId);
      if (data.includes("[PTY 读取错误]") || data.includes("Pi 已停止") || data.includes("Pi 已退出")) {
        debugLog("processing false by terminal error", { sessionId });
        setSessionRuntimeStatus(sessionId, { processing: false });
        markLatestTurnStatus(sessionId, "failed", data);
        return;
      }
      outputIdleTimersRef.current[sessionId] = setTimeout(() => {
        debugLog("processing false by idle fallback", { sessionId });
        setSessionRuntimeStatus(sessionId, { processing: false });
        markLatestTurnStatus(sessionId, "completed");
        delete outputIdleTimersRef.current[sessionId];
      }, 4000);
    }).then((f) => unsubs.push(f));
    getCurrentWebview().onDragDropEvent((event) => {
      if (event.payload?.type === "drop") {
        insertFileAttachments(event.payload.paths || []);
      }
    }).then((f) => unsubs.push(f));
    return () => {
      Object.values(outputIdleTimersRef.current).forEach((timer) => clearTimeout(timer));
      outputIdleTimersRef.current = {};
      Object.values(sessionWarmupTimersRef.current).forEach((timer) => clearTimeout(timer));
      sessionWarmupTimersRef.current = {};
      if (persistOutputTimerRef.current) clearTimeout(persistOutputTimerRef.current);
      if (projectsRenderTimerRef.current) clearTimeout(projectsRenderTimerRef.current);
      setProjects(projectsRef.current);
      persistCurrentSessionOutput();
      unsubs.forEach((f) => f());
    };
  }, []);

  useEffect(() => {
    const project = projects.find((p) => p.id === activeProjectId);
    const session = project?.sessions?.find((s) => s.id === activeProjectSessionId);
    if (project && session) {
      setWorkdir(project.path);
      localStorage.setItem("workdir", project.path);
      localStorage.setItem(ACTIVE_PROJECT_STORAGE_KEY, project.id);
      localStorage.setItem(ACTIVE_SESSION_STORAGE_KEY, session.id);
    } else {
      localStorage.removeItem(ACTIVE_PROJECT_STORAGE_KEY);
      localStorage.removeItem(ACTIVE_SESSION_STORAGE_KEY);
    }
  }, [projects, activeProjectId, activeProjectSessionId]);

  function createOrSelectProjectForPath(path, { createNewSession = false, sessionTitle = "新 Pi 会话", startCommand = "" } = {}) {
    persistCurrentSessionOutput();
    const now = new Date().toISOString();
    const existing = projectsRef.current.find((p) => p.path === path && !p.archived);
    let projectId = existing?.id || makeId("project");
    let sessionId = null;
    let nextProjects;

    if (existing) {
      const sessions = existing.sessions || [];
      const visibleSessions = sessions.filter((session) => !session.archived);
      if (createNewSession || visibleSessions.length === 0) {
        sessionId = makeId("pi-session");
        nextProjects = projectsRef.current.map((project) => project.id === existing.id
          ? {
              ...project,
              updated_at: now,
              sessions: [...sessions, { id: sessionId, title: sessionTitle, created_at: now, updated_at: now, output: "", start_command: startCommand, draft_command: "", attachments: [], turns: [], referenced_files: [], output_files: [] }]
            }
          : project);
      } else {
        sessionId = visibleSessions[0].id;
        nextProjects = projectsRef.current;
      }
    } else {
      sessionId = makeId("pi-session");
      nextProjects = [
        ...projectsRef.current,
        {
          id: projectId,
          name: basename(path),
          path,
          created_at: now,
          updated_at: now,
          sessions: [{ id: sessionId, title: sessionTitle, created_at: now, updated_at: now, output: "", start_command: startCommand, draft_command: "", attachments: [], turns: [], referenced_files: [], output_files: [] }]
        }
      ];
    }

    saveProjects(nextProjects);
    markSessionBackgroundState(activeProjectSessionIdRef.current, sessionId);
    activeProjectIdRef.current = projectId;
    activeProjectSessionIdRef.current = sessionId;
    setActiveProjectId(projectId);
    setActiveProjectSessionId(sessionId);
    setWorkdir(path);
    outputBufferRef.current = "";
    setCommand("");
    setAttachments([]);
    if (terminalReplayContent) setTerminalReplayContent("");
    setTerminalReplaySignal((value) => value + 1);
    return { projectId, sessionId, path };
  }

  async function addProject() {
    const selected = await open({ directory: true, multiple: false, title: "选择项目目录" });
    if (typeof selected !== "string") return;
    const existing = projectsRef.current.find((p) => p.path === selected && !p.archived);
    const existingSession = existing?.sessions?.find((session) => !session.archived);
    if (existing && existingSession) {
      selectProjectSession(existing.id, existingSession.id);
      setTimeout(() => invoke("ensure_pi_ide_config", { workdir: selected, legacyCommand: legacyPiCommandRef.current }).catch(() => {}), 800);
      return;
    }
    createOrSelectProjectForPath(selected);
    setTimeout(() => invoke("ensure_pi_ide_config", { workdir: selected, legacyCommand: legacyPiCommandRef.current }).catch(() => {}), 800);
  }

  function createProjectSession(projectId) {
    persistCurrentSessionOutput();
    const now = new Date().toISOString();
    const sessionId = makeId("pi-session");
    const nextProjects = projectsRef.current.map((project) => project.id === projectId
      ? {
          ...project,
          collapsed: false,
          updated_at: now,
          sessions: [
            ...(project.sessions || []),
            { id: sessionId, title: "新 Pi 会话", created_at: now, updated_at: now, output: "", draft_command: "", attachments: [], turns: [], referenced_files: [], output_files: [] }
          ]
        }
      : project);
    saveProjects(nextProjects);
    markSessionBackgroundState(activeProjectSessionIdRef.current, sessionId);
    activeProjectIdRef.current = projectId;
    activeProjectSessionIdRef.current = sessionId;
    setActiveProjectId(projectId);
    setActiveProjectSessionId(sessionId);
    outputBufferRef.current = "";
    setTerminalReplayContent("");
    setCommand("");
    setAttachments([]);
    setTerminalReplaySignal((value) => value + 1);
    const project = nextProjects.find((item) => item.id === projectId);
    return { projectId, sessionId, path: project?.path };
  }

  async function createAndStartProjectSession(projectId) {
    const created = createProjectSession(projectId);
    if (created?.path) invoke("ensure_pi_ide_config", { workdir: created.path, legacyCommand: legacyPiCommandRef.current }).catch(() => {});
  }

  function toggleProject(projectId) {
    saveProjects(projectsRef.current.map((project) => project.id === projectId ? { ...project, collapsed: !project.collapsed } : project));
  }

  async function openProjectInExplorer(projectId) {
    const project = projectsRef.current.find((p) => p.id === projectId);
    if (!project?.path) return;
    await invoke("open_path_in_file_manager", { path: project.path });
    setStatus(`已在资源管理器打开：${project.name}`);
  }

  function activateFirstVisibleProjectSession(nextProjects) {
    const nextProject = nextProjects.find((project) => !project.archived && (project.sessions || []).some((session) => !session.archived));
    const nextSession = nextProject?.sessions?.find((session) => !session.archived);
    if (nextProject && nextSession) {
      selectProjectSession(nextProject.id, nextSession.id);
      return;
    }
    activeProjectIdRef.current = null;
    activeProjectSessionIdRef.current = null;
    setActiveProjectId(null);
    setActiveProjectSessionId(null);
    outputBufferRef.current = "";
    setTerminalReplayContent("");
    setTerminalReplaySignal((value) => value + 1);
  }

  async function archiveProject(projectId) {
    const project = projectsRef.current.find((p) => p.id === projectId);
    if (!project) return;
    if (!window.confirm(`确定归档项目「${project.name}」吗？归档后会从当前列表隐藏，不会删除磁盘文件或 Pi 原生会话。`)) return;
    await Promise.all((project.sessions || []).map((session) => invoke("stop_pi_session", { sessionId: session.id }).catch(() => {})));
    setPiSessionStatus((prev) => {
      const next = { ...prev };
      for (const session of project.sessions || []) delete next[session.id];
      return next;
    });
    const now = new Date().toISOString();
    const nextProjects = projectsRef.current.map((p) => p.id === projectId
      ? { ...p, archived: true, archived_at: now, updated_at: now }
      : p);
    saveProjects(nextProjects);
    if (activeProjectIdRef.current === projectId) {
      activateFirstVisibleProjectSession(nextProjects);
    }
  }

  async function archiveProjectSession(projectId, sessionId) {
    const project = projectsRef.current.find((p) => p.id === projectId);
    const session = project?.sessions?.find((s) => s.id === sessionId);
    if (!project || !session) return;
    if (!window.confirm(`确定归档会话「${session.title}」吗？归档后会从当前列表隐藏，不会删除 Pi 原生会话。`)) return;
    await invoke("stop_pi_session", { sessionId }).catch(() => {});
    setPiSessionStatus((prev) => {
      const next = { ...prev };
      delete next[sessionId];
      return next;
    });
    const now = new Date().toISOString();
    const nextProjects = projectsRef.current.map((p) => p.id === projectId
      ? { ...p, sessions: (p.sessions || []).map((s) => s.id === sessionId ? { ...s, archived: true, archived_at: now, updated_at: now } : s) }
      : p);
    saveProjects(nextProjects);
    if (activeProjectSessionIdRef.current === sessionId) {
      const nextProject = nextProjects.find((p) => p.id === projectId);
      const nextSession = nextProject?.sessions?.find((session) => !session.archived);
      if (nextSession) selectProjectSession(projectId, nextSession.id);
      else activateFirstVisibleProjectSession(nextProjects);
    }
  }

  function renameProjectSession(projectId, sessionId, nextTitle) {
    const project = projectsRef.current.find((p) => p.id === projectId);
    const session = project?.sessions?.find((s) => s.id === sessionId);
    const title = String(nextTitle || "").trim();
    if (!session || !title) return false;
    try {
      saveProjects(projectsRef.current.map((p) => p.id === projectId
        ? { ...p, sessions: (p.sessions || []).map((s) => s.id === sessionId ? { ...s, title, user_renamed: true, updated_at: new Date().toISOString() } : s) }
        : p));
      return true;
    } catch {
      return false;
    }
  }

  function selectProjectSession(projectId, sessionId, options = {}) {
    debugLog("selectProjectSession enter", { projectId, sessionId, current: activeProjectSessionIdRef.current, options });
    persistCurrentSessionOutput();
    const project = projectsRef.current.find((p) => p.id === projectId);
    const session = project?.sessions?.find((s) => s.id === sessionId);
    if (!project || !session) {
      debugLog("selectProjectSession missing", { projectId, sessionId });
      return null;
    }
    const sameSession = sessionId === activeProjectSessionIdRef.current;
    markSessionBackgroundState(activeProjectSessionIdRef.current, sessionId);
    activeProjectIdRef.current = projectId;
    activeProjectSessionIdRef.current = sessionId;
    setActiveProjectId(projectId);
    setActiveProjectSessionId(sessionId);
    setWorkdir(project.path);
    outputBufferRef.current = session.output || "";
    setCommand(session.draft_command || "");
    setAttachments(session.attachments || []);
    if (!sameSession && !options.skipReplay) {
      if (centerView === "terminal") {
        replayTerminalTail(sessionId, session.output || "");
        debugLog("selectProjectSession replay", { sessionId, outputBytes: (session.output || "").length });
      } else {
        setTerminalReplayContent("");
        setTerminalReplaySignal((value) => value + 1);
        debugLog("selectProjectSession defer replay", { sessionId, outputBytes: (session.output || "").length });
      }
    } else if (!sameSession && options.skipReplay) {
      setTerminalReplayContent("");
      setTerminalReplaySignal((value) => value + 1);
      debugLog("selectProjectSession skip replay", { sessionId, outputBytes: (session.output || "").length });
    } else {
      debugLog("selectProjectSession same session no replay", { sessionId });
    }
    return { project, session };
  }

  async function activateProjectSession(projectId, sessionId) {
    debugLog("activateProjectSession enter", { projectId, sessionId, status: piSessionStatusRef.current[sessionId] });
    const selected = selectProjectSession(projectId, sessionId);
    if (!selected?.project || !selected?.session) return;
    scheduleSessionWarmup(sessionId, selected.project.path, selected.session);
  }

  function updateActiveProjectSessionAfterCommand(commandText) {
    const projectId = activeProjectIdRef.current;
    const sessionId = activeProjectSessionIdRef.current;
    if (!projectId || !sessionId) return;
    const now = new Date().toISOString();
    const title = commandText.length > 28 ? `${commandText.slice(0, 28)}…` : commandText;
    const nextProjects = projectsRef.current.map((project) => {
      if (project.id !== projectId) return project;
      return {
        ...project,
        updated_at: now,
        sessions: (project.sessions || []).map((session) => session.id === sessionId
          ? {
              ...session,
              title: !session.user_renamed && !session.first_prompt ? title : session.title,
              first_prompt: session.first_prompt || commandText,
              updated_at: now
            }
          : session)
      };
    });
    saveProjects(nextProjects);
  }

  function recordSessionStart(runWorkdir) {
    const projectId = activeProjectIdRef.current;
    const sessionId = activeProjectSessionIdRef.current;
    if (!projectId || !sessionId) return;
    const now = new Date().toISOString();
    const nextProjects = projectsRef.current.map((project) => project.id === projectId
      ? {
          ...project,
          updated_at: now,
          sessions: (project.sessions || []).map((session) => session.id === sessionId
            ? { ...session, workdir: runWorkdir, updated_at: now }
            : session)
        }
      : project);
    saveProjects(nextProjects);
  }

  async function startPi(options = {}) {
    debugLog("startPi enter", { options, active: activeProjectSessionIdRef.current, status: piSessionStatusRef.current[options.sessionId || activeProjectSessionIdRef.current] });
    let runWorkdir = options.workdir || activeProject?.path || workdir;
    let sessionId = options.sessionId || activeProjectSessionIdRef.current;

    if (!runWorkdir) {
      const selected = await open({ directory: true, multiple: false, title: "选择项目目录" });
      if (typeof selected !== "string") return;
      runWorkdir = selected;
      const created = createOrSelectProjectForPath(selected, { createNewSession: true, sessionTitle: "新 Pi 会话" });
      sessionId = created.sessionId;
    } else if (!sessionId) {
      const created = createOrSelectProjectForPath(runWorkdir, { createNewSession: true, sessionTitle: "新 Pi 会话" });
      sessionId = created.sessionId;
    }

    if (!sessionId) throw new Error("请先选择或创建一个会话");
    await ensurePiEnvironmentReady(runWorkdir);
    if (piSessionStatusRef.current[sessionId]?.running) {
      debugLog("startPi skip running", { sessionId });
      return;
    }
    if (startingSessionsRef.current.has(sessionId)) {
      debugLog("startPi skip starting", { sessionId });
      return;
    }
    const { session } = getSessionById(sessionId);
    const continueSession = options.continueSession ?? shouldContinueSession(session);

    if (runWorkdir) localStorage.setItem("workdir", runWorkdir);
    recordSessionStart(runWorkdir);
    startingSessionsRef.current.add(sessionId);
    setSessionRuntimeStatus(sessionId, { starting: true, runId: null, status: "Pi 启动中" });
    try {
      debugLog("startPi invoke", { sessionId, workdir: runWorkdir, continueSession });
      await invoke("start_pi_session", { sessionId, piCommand: legacyPiCommandRef.current, workdir: runWorkdir, continueSession });
      debugLog("startPi done", { sessionId });
      touchPiSessionActivity(sessionId, { running: true, starting: false, processing: false, status: "Pi 已启动" });
      flushPendingPiInputs(sessionId).catch((error) => {
        debugLog("flush pending inputs after start failed", { sessionId, error: String(error) });
        setStatus(`发送排队消息失败：${String(error)}`);
      });
    } catch (error) {
      debugLog("startPi failed", { sessionId, error: String(error) });
      setSessionRuntimeStatus(sessionId, { running: false, starting: false, processing: false, status: `Pi 启动失败：${String(error)}` });
      throw error;
    } finally {
      startingSessionsRef.current.delete(sessionId);
    }
  }

  function queuePiInput(sessionId, input) {
    if (!sessionId || !input) return;
    pendingPiInputsRef.current[sessionId] = [...(pendingPiInputsRef.current[sessionId] || []), input];
    setSessionRuntimeStatus(sessionId, { processing: true, status: "Pi 启动中，消息已排队" });
    setStatus("Pi 正在启动，消息已排队，启动完成后会自动发送");
  }

  async function flushPendingPiInputs(sessionId) {
    if (!sessionId || !piSessionStatusRef.current[sessionId]?.running) return;
    const queued = pendingPiInputsRef.current[sessionId] || [];
    if (queued.length === 0) return;
    pendingPiInputsRef.current[sessionId] = [];
    await applyPendingModel(sessionId);
    for (const input of queued) {
      await sendToRunningPi(sessionId, input);
    }
    setStatus(`已发送 ${queued.length} 条排队消息`);
  }

  function scheduleSessionWarmup(sessionId, projectPath, session) {
    if (!sessionId || !projectPath) return;
    if (piSessionStatusRef.current[sessionId]?.running || piSessionStatusRef.current[sessionId]?.starting) return;
    if (sessionWarmupTimersRef.current[sessionId]) clearTimeout(sessionWarmupTimersRef.current[sessionId]);
    sessionWarmupTimersRef.current[sessionId] = window.setTimeout(() => {
      delete sessionWarmupTimersRef.current[sessionId];
      startPi({
        sessionId,
        workdir: projectPath,
        continueSession: shouldContinueSession(session)
      }).catch((error) => {
        debugLog("session warmup failed", { sessionId, error: String(error) });
        setStatus(`启动 Pi 失败：${String(error)}`);
      });
    }, 250);
  }

  async function ensureActivePiRunning() {
    const sessionId = activeProjectSessionIdRef.current;
    debugLog("ensureActivePiRunning", { sessionId, status: piSessionStatusRef.current[sessionId] });
    if (!sessionId) throw new Error("请先选择或创建一个会话");
    if (!piSessionStatusRef.current[sessionId]?.running) {
      const { project, session } = getSessionById(sessionId);
      if (!project || !session) throw new Error("当前会话不存在");
      if (piSessionStatusRef.current[sessionId]?.starting || startingSessionsRef.current.has(sessionId)) return;
      await startPi({
        sessionId,
        workdir: project.path,
        continueSession: shouldContinueSession(session)
      });
    }
    if (piSessionStatusRef.current[sessionId]?.running) await applyPendingModel(sessionId);
  }

  async function sendToRunningPi(sessionId, input) {
    if (!sessionId) throw new Error("请先选择或创建一个会话");
    if (!piSessionStatusRef.current[sessionId]?.running) throw new Error("当前会话 Pi 尚未启动");
    touchPiSessionActivity(sessionId);
    await invoke("send_pi_input", { sessionId, input });
  }

  async function applyPendingModel(sessionId) {
    const { session } = getSessionById(sessionId);
    const pending = normalizeModelInfo(session?.pending_model);
    if (!pending) return;
    const payload = JSON.stringify({ provider: pending.provider, id: pending.id });
    setStatus(`正在应用待切换模型：${formatModelInfo(pending)}`);
    await sendToRunningPi(sessionId, `/pi-ide-switch-model ${payload}\r`);
    updateSessionById(sessionId, (current) => ({
      ...current,
      pending_model: null,
      current_model: pending,
      updated_at: new Date().toISOString()
    }));
  }

  async function sendToActivePi(input) {
    const sessionId = activeProjectSessionIdRef.current;
    if (!sessionId) throw new Error("请先选择或创建一个会话");
    const runtime = piSessionStatusRef.current[sessionId] || {};
    if (runtime.running) {
      await applyPendingModel(sessionId);
      await sendToRunningPi(sessionId, input);
      return;
    }

    queuePiInput(sessionId, input);
    const { project, session } = getSessionById(sessionId);
    if (!project || !session) throw new Error("当前会话不存在");
    if (!runtime.starting && !startingSessionsRef.current.has(sessionId)) {
      startPi({
        sessionId,
        workdir: project.path,
        continueSession: shouldContinueSession(session)
      }).catch((error) => {
        debugLog("sendToActivePi start failed", { sessionId, error: String(error) });
        setSessionRuntimeStatus(sessionId, { starting: false, processing: false, status: `Pi 启动失败：${String(error)}` });
        markLatestTurnStatus(sessionId, "failed", String(error));
        setStatus(`启动 Pi 失败：${String(error)}`);
      });
    }
  }

  async function handleTerminalInput(data) {
    const sessionId = activeProjectSessionIdRef.current;
    try {
      await sendToActivePi(data);
    } catch (error) {
      debugLog("terminal input failed", { sessionId, error: String(error) });
      setStatus(String(error));
      if (sessionId) setSessionRuntimeStatus(sessionId, { starting: false, processing: false, status: String(error) });
    }
  }

  async function loadConfiguredModelCandidates(sessionId = activeProjectSessionIdRef.current) {
    if (!sessionId) throw new Error("请先选择或创建一个会话");
    const projectPath = getSessionById(sessionId).project?.path || activeProject?.path || workdir;
    const result = await invoke("load_pi_model_config", { workdir: projectPath || null });
    const models = (Array.isArray(result?.models) ? result.models : []).map(normalizeModelInfo).filter(Boolean);
    const defaultModel = normalizeModelInfo(result?.defaultModel || result?.default_model);
    updateSessionById(sessionId, (session) => ({
      ...session,
      available_models: models.length > 0 ? models : session.available_models || [],
      current_model: session.current_model || defaultModel || null,
      model_list_source: "pi-config",
      updated_at: new Date().toISOString()
    }));
    if (defaultModel && !piSessionStatusRef.current[sessionId]?.model) {
      setSessionRuntimeStatus(sessionId, { model: defaultModel });
    }
    return { models, defaultModel };
  }

  async function refreshModels() {
    const sessionId = activeProjectSessionIdRef.current;
    try {
      if (sessionId && piSessionStatusRef.current[sessionId]?.running) {
        await sendToRunningPi(sessionId, "/pi-ide-list-models\r");
        setStatus("正在刷新模型列表...");
      } else {
        const result = await loadConfiguredModelCandidates(sessionId);
        setStatus(result.models.length > 0 || result.defaultModel ? "已读取 Pi 配置模型候选" : "未找到 Pi 配置模型候选");
      }
    } catch (error) {
      setStatus(`刷新模型列表失败：${String(error)}`);
    }
  }

  async function switchModel(model) {
    const label = formatModelInfo(model);
    const sessionId = activeProjectSessionIdRef.current;
    try {
      if (!sessionId) throw new Error("请先选择或创建一个会话");
      const payload = JSON.stringify({ provider: model.provider, id: model.id });
      if (piSessionStatusRef.current[sessionId]?.running) {
        setStatus(`正在切换模型：${label}`);
        await sendToRunningPi(sessionId, `/pi-ide-switch-model ${payload}\r`);
        updateSessionById(sessionId, (session) => ({ ...session, pending_model: null, updated_at: new Date().toISOString() }));
      } else {
        const pending = normalizeModelInfo(model);
        updateSessionById(sessionId, (session) => ({
          ...session,
          pending_model: pending,
          updated_at: new Date().toISOString()
        }));
        setStatus(`已选择模型，发送任务时应用：${label}`);
      }
      setModelMenuOpen(false);
    } catch (error) {
      setStatus(`模型切换失败：${String(error)}`);
    }
  }

  async function toggleModelMenu() {
    const next = !modelMenuOpen;
    setModelMenuOpen(next);
    if (next) await refreshModels();
  }

  async function stopProjectSessionPi(sessionId, { reason = "manual" } = {}) {
    if (!sessionId) return;
    clearSessionIdleTimer(sessionId);
    setSessionRuntimeStatus(sessionId, { idleStopping: true });
    try {
      await invoke("stop_pi_session", { sessionId });
    } finally {
      setSessionRuntimeStatus(sessionId, {
        running: false,
        starting: false,
        processing: false,
        idleStopping: false,
        backgroundSinceAt: null,
        status: reason === "idle" ? "Pi 已因后台空闲自动关闭" : "Pi 已停止"
      });
    }
  }

  function clearTerminal() {
    const sessionId = activeProjectSessionIdRef.current;
    if (sessionId) {
      invoke("clear_terminal_log", { sessionId }).catch(() => {});
      updateSessionById(sessionId, (session) => ({ ...session, output: "", updated_at: new Date().toISOString() }));
    }
    outputBufferRef.current = "";
    setClearTerminalSignal((value) => value + 1);
  }

  async function stopCurrentRun() {
    const sessionId = activeProjectSessionIdRef.current;
    if (!sessionId) return;
    await sendToRunningPi(sessionId, "\x03");
    clearSessionIdleTimer(sessionId);
    setSessionRuntimeStatus(sessionId, { processing: false });
    markLatestTurnStatus(sessionId, "cancelled");
  }

  async function sendCommand(raw = command) {
    const userText = String(raw || "").trim();
    const finalPrompt = buildPromptWithAttachments(userText, attachments);
    if (!finalPrompt.trim()) return;
    const titleSource = titleFromPromptAndAttachments(userText, attachments);
    const projectPath = activeProject?.path || workdir;
    const attachmentFiles = fileRecordsFromPaths(attachments.map((item) => item.path), "user-attachment");
    const inputPathFiles = fileRecordsFromPaths(extractFilePathsFromText(userText, projectPath), "user-input");
    const sessionId = activeProjectSessionIdRef.current;
    if (!sessionId) throw new Error("请先选择或创建一个会话");
    const turn = createTimelineTurn({
      userText: userText || titleSource,
      finalPrompt,
      attachments: [...attachmentFiles, ...inputPathFiles]
    });
    addTurnToSession(sessionId, turn);
    addSessionFiles("referenced", [...attachmentFiles, ...inputPathFiles]);
    setSessionRuntimeStatus(sessionId, { processing: true });
    try {
      await sendToActivePi(`${finalPrompt}\r`);
    } catch (error) {
      setSessionRuntimeStatus(sessionId, { processing: false });
      markLatestTurnStatus(sessionId, "failed", String(error));
      throw error;
    }
    updateActiveProjectSessionAfterCommand(titleSource);
    setCommand("");
    setAttachments([]);
    if (sessionId) {
      updateSessionById(sessionId, (session) => ({ ...session, draft_command: "", attachments: [], updated_at: new Date().toISOString() }));
    }
  }

  function insertFileAttachments(paths) {
    const uniquePaths = [...new Set(paths.filter(Boolean).map(String))];
    if (uniquePaths.length === 0) return;

    const existing = new Set(attachments.map((item) => item.path));
    const additions = uniquePaths
      .filter((path) => !existing.has(path))
      .map((path) => ({
        id: makeId("attachment"),
        name: basename(path),
        path,
        token: quotePath(path)
      }));

    if (additions.length === 0) {
      setStatus("文件已在会话文件中");
      requestAnimationFrame(() => inputRef.current?.focus());
      return;
    }

    setAttachments((prev) => {
      const prevPaths = new Set(prev.map((item) => item.path));
      const next = [...prev, ...additions.filter((item) => !prevPaths.has(item.path))];
      const sessionId = activeProjectSessionIdRef.current;
      if (sessionId) updateSessionById(sessionId, (session) => ({ ...session, attachments: next, updated_at: new Date().toISOString() }));
      return next;
    });
    setStatus(additions.length === 1 ? `已加入会话文件：${additions[0].name}` : `已加入 ${additions.length} 个会话文件`);
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  function removeAttachment(id) {
    setAttachments((items) => {
      const next = items.filter((attachment) => attachment.id !== id);
      const sessionId = activeProjectSessionIdRef.current;
      if (sessionId) updateSessionById(sessionId, (session) => ({ ...session, attachments: next, updated_at: new Date().toISOString() }));
      return next;
    });
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  async function chooseFiles() {
    const selected = await open({ multiple: true, title: "选择要插入的文件" });
    if (!selected) return;
    const files = Array.isArray(selected) ? selected : [selected];
    insertFileAttachments(files);
  }

  function insertText(text) {
    const el = inputRef.current;
    if (!el) {
      setCommand((prev) => {
        const nextValue = `${prev}${text}`;
        const sessionId = activeProjectSessionIdRef.current;
        if (sessionId) updateSessionById(sessionId, (session) => ({ ...session, draft_command: nextValue, updated_at: new Date().toISOString() }));
        return nextValue;
      });
      return;
    }
    const { nextValue, nextCursor } = insertAtCursor(el, text);
    setCommand(nextValue);
    const sessionId = activeProjectSessionIdRef.current;
    if (sessionId) updateSessionById(sessionId, (session) => ({ ...session, draft_command: nextValue, updated_at: new Date().toISOString() }));
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(nextCursor, nextCursor);
    });
  }

  function handleDrop(e) {
    e.preventDefault();
    e.stopPropagation();
    const treeFilePath = e.dataTransfer.getData("application/x-pi-file-path");
    if (treeFilePath) {
      insertFileAttachments([treeFilePath]);
      return;
    }
    const droppedText = e.dataTransfer.getData("text/plain");
    if (droppedText?.startsWith('"') && droppedText.endsWith('"')) {
      insertFileAttachments([droppedText.slice(1, -1).replace(/\\"/g, '"')]);
      return;
    }
    const files = Array.from(e.dataTransfer.files || []);
    const paths = files.map((f) => f.path || f.name).filter(Boolean);
    if (paths.length) insertFileAttachments(paths);
  }

  function handleComposerDragOver(e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }

  function handleComposerAction() {
    if (isProcessing) stopCurrentRun().catch((err) => setStatus(String(err)));
    else if (!piEnvironmentReady) {
      setPiSetupOpen(true);
      checkPiEnvironment(activeProject?.path || workdir, { showStatus: true, force: true }).catch((err) => setStatus(String(err)));
    } else {
      sendCommand().catch((err) => setStatus(String(err)));
    }
  }

  function handleCommandChange(e) {
    const nextValue = e.target.value;
    setCommand(nextValue);
    const sessionId = activeProjectSessionIdRef.current;
    if (sessionId) updateSessionById(sessionId, (session) => ({ ...session, draft_command: nextValue, updated_at: new Date().toISOString() }));
  }

  function handleKeyDown(e) {
    if (e.key !== "Enter" || e.nativeEvent?.isComposing) return;
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      insertText("\n");
    } else {
      handleComposerAction();
    }
  }

  return (
    <div className="app" onDragOver={(e) => e.preventDefault()} onDrop={handleDrop}>
      <aside className="sidebar left">
        <div className="brand">Pi IDE</div>
        <ProjectPanel
          projects={projects}
          activeProjectId={activeProjectId}
          activeSessionId={activeProjectSessionId}
          piSessionStatus={piSessionStatus}
          onAddProject={() => addProject().catch((e) => setStatus(String(e)))}
          onNewSession={(projectId) => createAndStartProjectSession(projectId).catch((e) => setStatus(String(e)))}
          onSelectSession={(projectId, sessionId) => activateProjectSession(projectId, sessionId).catch((e) => setStatus(String(e)))}
          onToggleProject={toggleProject}
          onStopSessionPi={(sessionId) => stopProjectSessionPi(sessionId).catch((e) => setStatus(String(e)))}
          onArchiveProject={archiveProject}
          onArchiveSession={archiveProjectSession}
          onRenameSession={renameProjectSession}
          onOpenProjectInExplorer={(projectId) => openProjectInExplorer(projectId).catch((e) => setStatus(String(e)))}
        />
      </aside>

      <main className="main">
        <header className="topbar">
          <span className="status">{status}</span>
          <div className="view-switch">
            <button className={centerView === "session" ? "primary" : ""} onClick={() => setCenterView("session")}>
              <MessageSquare size={15}/> 会话视图
            </button>
            <button className={centerView === "terminal" ? "primary" : ""} onClick={() => setCenterView("terminal")}>
              <TerminalSquare size={15}/> 终端视图
            </button>
          </div>
          <button className={piEnvironmentReady ? "" : "danger"} onClick={() => setPiSetupOpen((value) => !value)} title="检查和配置 Pi 环境">
            <Settings size={15}/> 环境设置
          </button>
          {debugLogEnabled && <button onClick={openDebugLog} title="打开调试日志所在目录"><FileText size={15}/> 调试日志</button>}
        </header>
        <div className="center-view-wrap">
          {showPiSetupPanel ? (
            <PiSetupPanel
              environment={piEnvironment}
              checking={piEnvironmentChecking}
              installing={piInstalling}
              modelDraft={modelTemplateDraft}
              onModelDraftChange={setModelTemplateDraft}
              onCheck={() => checkPiEnvironment(activeProject?.path || workdir, { showStatus: true, force: true })}
              onInstall={installPiCli}
              onSaveModel={savePiModelTemplate}
              onOpenDebugLog={openDebugLog}
              onClose={() => setPiSetupOpen(false)}
            />
          ) : centerView === "session" ? (
            <SessionTimeline
              project={activeProject}
              session={activeProjectSession}
              runtimeStatus={activeProjectSessionId ? piSessionStatus[activeProjectSessionId] : null}
              onOpenFile={(file) => openSessionFile(file).catch((e) => setStatus(String(e)))}
              onOpenDirectory={(file) => openSessionFileDirectory(file).catch((e) => setStatus(String(e)))}
            />
          ) : (
            <PiTerminal
              activeSessionId={activeProjectSessionId}
              clearSignal={clearTerminalSignal}
              replaySignal={terminalReplaySignal}
              replayContent={terminalReplayContent}
              debugEnabled={debugLogEnabled}
              debugWorkdir={activeProject?.path || workdir}
              onTerminalInput={handleTerminalInput}
            />
          )}
        </div>
        <div className="composer" onDragOver={handleComposerDragOver} onDrop={handleDrop}>
          <div className="composer-toolbar">
            <div className="attachment-bar inline">
              {attachments.length === 0 ? (
                <span className="attachment-placeholder">拖入文件或点击右侧按钮插入路径</span>
              ) : attachments.map((attachment) => (
                <span className="attachment-chip" key={attachment.id} title={attachment.path}>
                  <File size={14}/>
                  <span>{attachment.name}</span>
                  <button type="button" className="attachment-remove" title="移除文件" onClick={() => removeAttachment(attachment.id)}><X size={13}/></button>
                </span>
              ))}
            </div>
            <button onClick={chooseFiles}><FolderOpen size={15}/> 插入文件</button>
          </div>
          <textarea
            ref={inputRef}
            value={command}
            onChange={handleCommandChange}
            onKeyDown={handleKeyDown}
            placeholder={'输入 Pi 指令或自然语言任务。例如：帮我分析这个文件 "/path/to/file"'}
          />
          <div className="composer-actions">
            <span>当前项目：{activeProject?.name || "未选择"} / 会话：{activeProjectSession?.title || "未选择"}</span>
            <div className="composer-action-buttons">
              <div className="model-picker">
                <button className="model-picker-button" onClick={() => toggleModelMenu().catch((e) => setStatus(String(e)))} title="切换当前 Pi 会话模型">
                  模型：{activeModelLabel ? `${activeModelLabel}${activeModelPending ? "（待应用）" : ""}` : "未获取"} <ChevronDown size={13}/>
                </button>
                {modelMenuOpen && (
                  <div className="model-menu">
                    <button className="model-menu-refresh" onClick={() => refreshModels().catch((e) => setStatus(String(e)))}><RefreshCw size={13}/> 刷新模型列表</button>
                    {sessionModelOptions(activeProjectSession).length === 0 && <div className="model-menu-empty">暂无可用模型，首次运行后会刷新完整列表</div>}
                    {sessionModelOptions(activeProjectSession).map((model) => {
                      const selectedModel = activeProjectSession?.pending_model || piSessionStatus[activeProjectSessionId]?.model || activeProjectSession?.current_model;
                      const selected = sameModel(model, selectedModel);
                      return (
                        <button key={`${model.provider}:${model.id}`} className={`model-menu-item ${selected ? "active" : ""}`} onClick={() => switchModel(model)}>
                          <span>{formatModelInfo(model)}</span>
                          {selected && <small>{sameModel(model, activeProjectSession?.pending_model) ? "待应用" : "当前"}</small>}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
              <button className={isProcessing || !piEnvironmentReady ? "danger" : "primary"} onClick={handleComposerAction}>
                {isProcessing ? <Square size={16}/> : <Send size={16}/>} {isProcessing ? "停止" : (piEnvironmentReady ? "发送" : "配置 Pi")}
              </button>
            </div>
          </div>
        </div>
      </main>

      <aside className="sidebar right">
        <RightToolPanel
          activeProject={activeProject}
          activeSession={activeProjectSession}
          toolListCollapsed={toolListCollapsed}
          directoryTreeOpen={directoryTreeOpen}
          sessionFilesOpen={sessionFilesOpen}
          directoryTree={directoryTree}
          directoryTreeLoading={directoryTreeLoading}
          directoryTreeError={directoryTreeError}
          expandedDirectoryPaths={expandedDirectoryPaths}
          directoryTreeNodeLoadingPaths={directoryTreeNodeLoadingPaths}
          directoryTreeSearch={directoryTreeSearch}
          onDirectoryTreeSearchChange={setDirectoryTreeSearch}
          onToggleToolList={() => setToolListCollapsed((value) => !value)}
          onToggleDirectoryTree={handleDirectoryTreeToolClick}
          onToggleSessionFiles={() => setSessionFilesOpen((value) => !value)}
          onRefreshDirectoryTree={() => loadDirectoryTree().catch((e) => setDirectoryTreeError(String(e)))}
          onToggleDirectoryNode={toggleDirectoryNode}
          onOpenDirectoryFile={(path) => openDirectoryFile(path).catch((e) => setStatus(String(e)))}
          onOpenSessionFile={(file) => openSessionFile(file).catch((e) => setStatus(String(e)))}
          onOpenSessionFileDirectory={(file) => openSessionFileDirectory(file).catch((e) => setStatus(String(e)))}
        />
      </aside>
    </div>
  );
}
