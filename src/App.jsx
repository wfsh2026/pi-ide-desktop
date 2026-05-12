import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import { writeText as writeClipboardText } from "@tauri-apps/plugin-clipboard-manager";
import { Play, Square, Send, FolderOpen, GitBranch, Copy, Plus, Folder, X, File, FolderTree, ChevronDown, ChevronRight, RefreshCw } from "lucide-react";
import PiTerminal from "./components/PiTerminal.jsx";

const DEFAULT_COMMAND = "pi";
const PROJECTS_STORAGE_KEY = "piIdeProjects";
const ACTIVE_PROJECT_STORAGE_KEY = "piIdeActiveProjectId";
const ACTIVE_SESSION_STORAGE_KEY = "piIdeActiveProjectSessionId";
const EXE_SESSION_STORAGE_KEY = "piIdeExeSessionId";

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

function loadProjects() {
  try {
    const raw = localStorage.getItem(PROJECTS_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
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

function ProjectPanel({ projects, activeProjectId, activeSessionId, piSessionStatus, onAddProject, onNewSession, onSelectSession, onToggleProject, onDeleteProject, onDeleteSession, onRenameSession, onOpenProjectInExplorer }) {
  const [menu, setMenu] = useState(null);
  const [editing, setEditing] = useState(null);
  const [draftTitle, setDraftTitle] = useState("");

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
        {projects.length === 0 && <div className="empty">暂无项目。点击 + 选择一个目录。</div>}
        {projects.map((project) => (
          <div className="project-group" key={project.id}>
            <div
              className={`project-heading ${activeProjectId === project.id ? "active" : ""}`}
              title={`${project.path}\n左键展开/收起，右键删除项目`}
              onClick={() => onToggleProject(project.id)}
              onContextMenu={(event) => openMenu(event, { type: "project", projectId: project.id })}
            >
              <Folder size={15}/>
              <span>{project.collapsed ? "▸" : "▾"} {project.name}</span>
              <button className="icon project-add-session" title="新建 Pi 会话" onClick={(event) => { event.stopPropagation(); onNewSession(project.id); }}><Plus size={13}/></button>
            </div>
            {!project.collapsed && (
              <div className="project-sessions">
                {(project.sessions || []).length === 0 && <div className="project-empty-session">暂无 Pi 会话</div>}
                {(project.sessions || []).map((session) => {
                  const isEditing = editing?.sessionId === session.id;
                  return (
                    <div
                      key={session.id}
                      className={`project-session ${activeSessionId === session.id ? "active" : ""}`}
                      onClick={() => !isEditing && onSelectSession(project.id, session.id)}
                      onContextMenu={(event) => openMenu(event, { type: "session", projectId: project.id, session })}
                      title={`${session.title}\n右键重命名/删除`}
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
                })}
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
          <button className="danger" onClick={() => {
            setMenu(null);
            if (menu.type === "project") Promise.resolve(onDeleteProject(menu.projectId)).catch(() => {});
            else Promise.resolve(onDeleteSession(menu.projectId, menu.session.id)).catch(() => {});
          }}>删除</button>
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

function HighlightText({ text, query }) {
  const value = String(text || "");
  const keyword = String(query || "").trim();
  if (!keyword) return value;
  const index = value.toLowerCase().indexOf(keyword.toLowerCase());
  if (index < 0) return value;
  return <>{value.slice(0, index)}<mark>{value.slice(index, index + keyword.length)}</mark>{value.slice(index + keyword.length)}</>;
}

function DirectoryTreeNodeView({ node, depth = 0, expandedPaths, searchText = "", onToggleDirectory, onOpenFile }) {
  if (!node) return null;
  const isDir = isDirectoryNode(node);
  const children = Array.isArray(node.children) ? node.children : [];
  const expanded = expandedPaths.has(node.path);
  const canExpand = isDir && !node.omitted && children.length > 0;

  function handleClick() {
    if (canExpand) onToggleDirectory(node.path);
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
        <span className="directory-tree-toggle">{isDir ? (canExpand ? (expanded ? "▾" : "▸") : "•") : ""}</span>
        {isDir ? <Folder size={14}/> : <File size={14}/>}
        <span className="directory-tree-name"><HighlightText text={node.name} query={searchText}/>{isDir ? "/" : ""}</span>
        {node.omitted && <em>已省略</em>}
      </div>
      {isDir && expanded && children.map((child) => (
        <DirectoryTreeNodeView
          key={`${child.path}-${child.name}`}
          node={child}
          depth={depth + 1}
          expandedPaths={expandedPaths}
          searchText={searchText}
          onToggleDirectory={onToggleDirectory}
          onOpenFile={onOpenFile}
        />
      ))}
    </>
  );
}

function SessionFilesSection({ title, files, emptyText, onOpenFile, onOpenDirectory }) {
  return (
    <div className="session-files-section">
      <h4>{title}</h4>
      {(!files || files.length === 0) && <div className="session-files-empty">{emptyText}</div>}
      {(files || []).map((file) => (
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
            <div className="directory-tree-note">目录较大，已限制展示深度和条目数。文件可双击打开，也可拖入下方会话框。</div>
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
  const [terminalInputEnabled, setTerminalInputEnabled] = useState(true);
  const [piSessionStatus, setPiSessionStatus] = useState({});
  const [openedFromContext, setOpenedFromContext] = useState(false);
  const [command, setCommand] = useState("");
  const [attachments, setAttachments] = useState([]);
  const [toolListCollapsed, setToolListCollapsed] = useState(false);
  const [directoryTreeOpen, setDirectoryTreeOpen] = useState(false);
  const [sessionFilesOpen, setSessionFilesOpen] = useState(false);
  const [directoryTree, setDirectoryTree] = useState(null);
  const [expandedDirectoryPaths, setExpandedDirectoryPaths] = useState(() => new Set());
  const [directoryTreeSearch, setDirectoryTreeSearch] = useState("");
  const [directoryTreeLoading, setDirectoryTreeLoading] = useState(false);
  const [directoryTreeError, setDirectoryTreeError] = useState("");
  const [piCommand, setPiCommand] = useState(localStorage.getItem("piCommand") || DEFAULT_COMMAND);
  const [workdir, setWorkdir] = useState(localStorage.getItem("workdir") || "");
  const [projects, setProjects] = useState(() => loadProjects());
  const [activeProjectId, setActiveProjectId] = useState(null);
  const [activeProjectSessionId, setActiveProjectSessionId] = useState(null);

  const inputRef = useRef(null);
  const outputBufferRef = useRef("");
  const outputIdleTimersRef = useRef({});
  const persistOutputTimerRef = useRef(null);
  const projectsRenderTimerRef = useRef(null);
  const fileEventSeenRef = useRef(new Set());
  const projectsRef = useRef(projects);
  const activeProjectIdRef = useRef(activeProjectId);
  const activeProjectSessionIdRef = useRef(activeProjectSessionId);
  const piSessionStatusRef = useRef(piSessionStatus);
  const launchHandledRef = useRef(false);

  useEffect(() => { projectsRef.current = projects; }, [projects]);
  useEffect(() => { activeProjectIdRef.current = activeProjectId; }, [activeProjectId]);
  useEffect(() => { activeProjectSessionIdRef.current = activeProjectSessionId; }, [activeProjectSessionId]);
  useEffect(() => { piSessionStatusRef.current = piSessionStatus; }, [piSessionStatus]);

  const activeProject = useMemo(() => projects.find((p) => p.id === activeProjectId), [projects, activeProjectId]);
  const activeProjectSession = useMemo(
    () => activeProject?.sessions?.find((s) => s.id === activeProjectSessionId),
    [activeProject, activeProjectSessionId]
  );
  const piStarted = Boolean(activeProjectSessionId && piSessionStatus[activeProjectSessionId]?.running);
  const isProcessing = Boolean(activeProjectSessionId && piSessionStatus[activeProjectSessionId]?.processing);

  const loadDirectoryTree = useCallback(async (projectPath = activeProject?.path) => {
    if (!projectPath) {
      setDirectoryTree(null);
      setExpandedDirectoryPaths(new Set());
      setDirectoryTreeError("请先在左侧选择一个项目");
      return;
    }
    setDirectoryTreeLoading(true);
    setDirectoryTreeError("");
    try {
      const result = await invoke("get_directory_tree", { path: projectPath });
      setDirectoryTree(result);
      setExpandedDirectoryPaths(new Set(result?.tree?.path ? [result.tree.path] : []));
    } catch (error) {
      setDirectoryTree(null);
      setExpandedDirectoryPaths(new Set());
      setDirectoryTreeError(String(error));
    } finally {
      setDirectoryTreeLoading(false);
    }
  }, [activeProject?.path]);

  useEffect(() => {
    if (!directoryTreeOpen) return;
    loadDirectoryTree(activeProject?.path);
  }, [directoryTreeOpen, activeProject?.path, loadDirectoryTree]);

  function toggleDirectoryNode(path) {
    setExpandedDirectoryPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
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

  function saveProjects(nextProjects) {
    projectsRef.current = nextProjects;
    setProjects(nextProjects);
    localStorage.setItem(PROJECTS_STORAGE_KEY, JSON.stringify(nextProjects));
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
    const next = {
      ...piSessionStatusRef.current,
      [sessionId]: { ...(piSessionStatusRef.current[sessionId] || {}), ...patch }
    };
    piSessionStatusRef.current = next;
    setPiSessionStatus(next);
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
      projectsRef.current = nextProjects;
      setProjects(nextProjects);
      if (persist) localStorage.setItem(PROJECTS_STORAGE_KEY, JSON.stringify(nextProjects));
    }
    return updatedSession;
  }

  function persistCurrentSessionOutput() {
    localStorage.setItem(PROJECTS_STORAGE_KEY, JSON.stringify(projectsRef.current));
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
          return { ...session, [field]: [...(session[field] || []), ...additions], updated_at: now };
        })
      };
    });
    if (changed) saveProjects(nextProjects);
  }

  function applyPiIdeFileEvents(events) {
    if (!Array.isArray(events) || events.length === 0) return;
    const bySession = new Map();

    for (const event of events) {
      if (!event?.path || !event?.kind) continue;
      const targetSessionId = event.ideSessionId || event.ide_session_id || activeProjectSessionIdRef.current;
      if (!targetSessionId) continue;
      const key = event.id || `${targetSessionId}:${event.kind}:${event.source}:${event.toolCallId}:${event.path}:${event.timestamp}`;
      if (fileEventSeenRef.current.has(key)) continue;
      fileEventSeenRef.current.add(key);

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
    const now = new Date().toISOString();
    let changed = false;
    const nextProjects = projectsRef.current.map((project) => ({
      ...project,
      sessions: (project.sessions || []).map((session) => {
        if (session.id !== sessionId) return session;
        changed = true;
        return { ...session, output: `${session.output || ""}${data}`, updated_at: now };
      })
    }));
    if (!changed) return;
    projectsRef.current = nextProjects;
    if (sessionId === activeProjectSessionIdRef.current) outputBufferRef.current += data;
    detectSessionFilesFromOutput(data, sessionId);
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
          const events = await invoke("load_pi_ide_file_events", { workdir: projectPath });
          if (!cancelled) applyPiIdeFileEvents(events);
        } catch (_) {
          // 文件跟踪扩展尚未生成或 Pi 未写入事件时忽略。
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
    setCommand("");
    outputBufferRef.current = "";
    setTerminalReplayContent("");
    setTerminalReplaySignal((value) => value + 1);

    invoke("get_launch_context").then((context) => {
      if (launchHandledRef.current) return;
      launchHandledRef.current = true;
      if (context?.openedFromContext || context?.opened_from_context) setOpenedFromContext(true);
      const projectPath = context?.projectPath || context?.project_path;
      if (projectPath) {
        const commandText = localStorage.getItem("piCommand") || DEFAULT_COMMAND;
        const created = createOrSelectProjectForPath(projectPath, { createNewSession: true, sessionTitle: `右键启动：${commandText}`, startCommand: commandText });
        startPi({ sessionId: created.sessionId, piCommand: commandText, workdir: projectPath }).catch((e) => setStatus(String(e)));
      }
    }).catch(() => {});

    const unsubs = [];
    listen("pi-status", (event) => {
      const payload = event.payload;
      const sessionId = payload && typeof payload === "object" ? (payload.sessionId || payload.session_id) : null;
      const text = payload && typeof payload === "object" ? String(payload.status || "") : String(payload || "");
      setStatus(text);
      if (sessionId) {
        const running = text.includes("Pi 已启动") || text.includes("Pi 已经在运行");
        const stopped = text.includes("Pi 已停止");
        const previous = piSessionStatusRef.current[sessionId] || {};
        setSessionRuntimeStatus(sessionId, {
          running: stopped ? false : running || previous.running || false,
          processing: stopped ? false : previous.processing || false,
          status: text
        });
      }
    }).then((f) => unsubs.push(f));
    listen("pi-output", (event) => {
      const payload = event.payload || {};
      const sessionId = payload.sessionId || payload.session_id;
      const data = String(payload.data ?? "");
      if (sessionId && data) appendOutputToSession(sessionId, data);

      if (!sessionId || !piSessionStatusRef.current[sessionId]?.processing) return;
      clearSessionIdleTimer(sessionId);
      if (data.includes("[PTY 读取错误]") || data.includes("Pi 已停止")) {
        setSessionRuntimeStatus(sessionId, { processing: false });
        return;
      }
      outputIdleTimersRef.current[sessionId] = setTimeout(() => {
        setSessionRuntimeStatus(sessionId, { processing: false });
        delete outputIdleTimersRef.current[sessionId];
      }, 2000);
    }).then((f) => unsubs.push(f));
    getCurrentWebview().onDragDropEvent((event) => {
      if (event.payload?.type === "drop") {
        insertFileAttachments(event.payload.paths || []);
      }
    }).then((f) => unsubs.push(f));
    return () => {
      Object.values(outputIdleTimersRef.current).forEach((timer) => clearTimeout(timer));
      outputIdleTimersRef.current = {};
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
    const existing = projectsRef.current.find((p) => p.path === path);
    let projectId = existing?.id || makeId("project");
    let sessionId = null;
    let nextProjects;

    if (existing) {
      const sessions = existing.sessions || [];
      if (createNewSession || sessions.length === 0) {
        sessionId = makeId("pi-session");
        nextProjects = projectsRef.current.map((project) => project.id === existing.id
          ? {
              ...project,
              updated_at: now,
              sessions: [...sessions, { id: sessionId, title: sessionTitle, created_at: now, updated_at: now, output: "", start_command: startCommand, draft_command: "", attachments: [], referenced_files: [], output_files: [] }]
            }
          : project);
      } else {
        sessionId = sessions[0].id;
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
          sessions: [{ id: sessionId, title: sessionTitle, created_at: now, updated_at: now, output: "", start_command: startCommand, draft_command: "", attachments: [], referenced_files: [], output_files: [] }]
        }
      ];
    }

    saveProjects(nextProjects);
    activeProjectIdRef.current = projectId;
    activeProjectSessionIdRef.current = sessionId;
    setActiveProjectId(projectId);
    setActiveProjectSessionId(sessionId);
    setWorkdir(path);
    outputBufferRef.current = "";
    setTerminalReplayContent("");
    setTerminalReplaySignal((value) => value + 1);
    return { projectId, sessionId, path };
  }

  async function addProject() {
    const selected = await open({ directory: true, multiple: false, title: "选择项目目录" });
    if (typeof selected !== "string") return;
    const existing = projectsRef.current.find((p) => p.path === selected);
    if (existing && (existing.sessions || []).length > 0) {
      selectProjectSession(existing.id, existing.sessions[0].id);
      return;
    }
    createOrSelectProjectForPath(selected);
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
            { id: sessionId, title: "新 Pi 会话", created_at: now, updated_at: now, output: "", draft_command: "", attachments: [], referenced_files: [], output_files: [] }
          ]
        }
      : project);
    saveProjects(nextProjects);
    activeProjectIdRef.current = projectId;
    activeProjectSessionIdRef.current = sessionId;
    setActiveProjectId(projectId);
    setActiveProjectSessionId(sessionId);
    outputBufferRef.current = "";
    setTerminalReplayContent("");
    setTerminalReplaySignal((value) => value + 1);
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

  async function deleteProject(projectId) {
    const project = projectsRef.current.find((p) => p.id === projectId);
    if (!project) return;
    if (!window.confirm(`确定删除项目「${project.name}」及其所有会话记录吗？不会删除磁盘文件。`)) return;
    await Promise.all((project.sessions || []).map((session) => invoke("stop_pi_session", { sessionId: session.id }).catch(() => {})));
    setPiSessionStatus((prev) => {
      const next = { ...prev };
      for (const session of project.sessions || []) delete next[session.id];
      return next;
    });
    const nextProjects = projectsRef.current.filter((p) => p.id !== projectId);
    saveProjects(nextProjects);
    if (activeProjectIdRef.current === projectId) {
      const nextProject = nextProjects[0];
      const nextSession = nextProject?.sessions?.[0];
      if (nextProject && nextSession) selectProjectSession(nextProject.id, nextSession.id);
      else {
        activeProjectIdRef.current = null;
        activeProjectSessionIdRef.current = null;
        setActiveProjectId(null);
        setActiveProjectSessionId(null);
        outputBufferRef.current = "";
        setTerminalReplayContent("");
        setTerminalReplaySignal((value) => value + 1);
      }
    }
  }

  async function deleteProjectSession(projectId, sessionId) {
    const project = projectsRef.current.find((p) => p.id === projectId);
    const session = project?.sessions?.find((s) => s.id === sessionId);
    if (!project || !session) return;
    if (!window.confirm(`确定删除会话「${session.title}」吗？`)) return;
    await invoke("stop_pi_session", { sessionId }).catch(() => {});
    setPiSessionStatus((prev) => {
      const next = { ...prev };
      delete next[sessionId];
      return next;
    });
    const nextProjects = projectsRef.current.map((p) => p.id === projectId ? { ...p, sessions: (p.sessions || []).filter((s) => s.id !== sessionId) } : p);
    saveProjects(nextProjects);
    if (activeProjectSessionIdRef.current === sessionId) {
      const nextProject = nextProjects.find((p) => p.id === projectId);
      const nextSession = nextProject?.sessions?.[0];
      if (nextSession) selectProjectSession(projectId, nextSession.id);
      else {
        activeProjectSessionIdRef.current = null;
        setActiveProjectSessionId(null);
        outputBufferRef.current = "";
        setTerminalReplayContent("");
        setTerminalReplaySignal((value) => value + 1);
      }
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

  function selectProjectSession(projectId, sessionId) {
    persistCurrentSessionOutput();
    const project = projectsRef.current.find((p) => p.id === projectId);
    const session = project?.sessions?.find((s) => s.id === sessionId);
    if (!project || !session) return;
    activeProjectIdRef.current = projectId;
    activeProjectSessionIdRef.current = sessionId;
    setActiveProjectId(projectId);
    setActiveProjectSessionId(sessionId);
    setWorkdir(project.path);
    outputBufferRef.current = session.output || "";
    setTerminalReplayContent(session.output || "");
    setCommand(session.draft_command || "");
    setAttachments(session.attachments || []);
    setPiCommand(session.start_command || localStorage.getItem("piCommand") || DEFAULT_COMMAND);
    setTerminalReplaySignal((value) => value + 1);
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

  function recordSessionStart(commandText, runWorkdir) {
    const projectId = activeProjectIdRef.current;
    const sessionId = activeProjectSessionIdRef.current;
    if (!projectId || !sessionId) return;
    const now = new Date().toISOString();
    const nextProjects = projectsRef.current.map((project) => project.id === projectId
      ? {
          ...project,
          updated_at: now,
          sessions: (project.sessions || []).map((session) => session.id === sessionId
            ? { ...session, start_command: commandText, workdir: runWorkdir, updated_at: now }
            : session)
        }
      : project);
    saveProjects(nextProjects);
  }

  async function startPi(options = {}) {
    const commandText = options.piCommand || piCommand || DEFAULT_COMMAND;
    let runWorkdir = options.workdir || activeProject?.path || workdir;
    if (!runWorkdir) {
      const selected = await open({ directory: true, multiple: false, title: "选择项目目录" });
      if (typeof selected !== "string") return;
      runWorkdir = selected;
      createOrSelectProjectForPath(selected, { createNewSession: true, sessionTitle: `启动：${commandText}`, startCommand: commandText });
    } else if (!activeProjectIdRef.current || !activeProjectSessionIdRef.current) {
      createOrSelectProjectForPath(runWorkdir, { createNewSession: true, sessionTitle: `启动：${commandText}`, startCommand: commandText });
    }
    localStorage.setItem("piCommand", commandText);
    if (runWorkdir) localStorage.setItem("workdir", runWorkdir);
    recordSessionStart(commandText, runWorkdir);
    const sessionId = options.sessionId || activeProjectSessionIdRef.current;
    if (!sessionId) throw new Error("请先选择或创建一个会话");
    await invoke("start_pi_session", { sessionId, piCommand: commandText, workdir: runWorkdir });
    setSessionRuntimeStatus(sessionId, { running: true, processing: false, status: "Pi 已启动" });
  }

  async function stopPi() {
    const sessionId = activeProjectSessionIdRef.current;
    if (!sessionId) return;
    await invoke("stop_pi_session", { sessionId });
    clearSessionIdleTimer(sessionId);
    setSessionRuntimeStatus(sessionId, { running: false, processing: false, status: "Pi 已停止" });
    persistCurrentSessionOutput();
  }

  async function stopAllPi() {
    await invoke("stop_all_pi_sessions");
    Object.keys(outputIdleTimersRef.current).forEach(clearSessionIdleTimer);
    const next = {};
    for (const sessionId of Object.keys(piSessionStatusRef.current)) {
      next[sessionId] = { ...(piSessionStatusRef.current[sessionId] || {}), running: false, processing: false, status: "Pi 已停止" };
    }
    piSessionStatusRef.current = next;
    setPiSessionStatus(next);
    setStatus("所有 Pi 已停止");
    persistCurrentSessionOutput();
  }

  function clearTerminal() {
    const sessionId = activeProjectSessionIdRef.current;
    if (sessionId) {
      updateSessionById(sessionId, (session) => ({ ...session, output: "", updated_at: new Date().toISOString() }));
    }
    outputBufferRef.current = "";
    setClearTerminalSignal((value) => value + 1);
  }

  async function copyOutput() {
    const output = activeProjectSession?.output || outputBufferRef.current;
    if (!output) {
      setStatus("当前没有可复制的输出");
      return;
    }
    await writeClipboardText(output);
    setStatus("终端输出已复制到剪贴板");
  }

  async function stopCurrentRun() {
    const sessionId = activeProjectSessionIdRef.current;
    if (!sessionId) return;
    await invoke("send_pi_input", { sessionId, input: "\x03" });
    clearSessionIdleTimer(sessionId);
    setSessionRuntimeStatus(sessionId, { processing: false });
  }

  async function sendCommand(raw = command) {
    const userText = String(raw || "").trim();
    const finalPrompt = buildPromptWithAttachments(userText, attachments);
    if (!finalPrompt.trim()) return;
    const titleSource = titleFromPromptAndAttachments(userText, attachments);
    const projectPath = activeProject?.path || workdir;
    const attachmentFiles = fileRecordsFromPaths(attachments.map((item) => item.path), "user-attachment");
    const inputPathFiles = fileRecordsFromPaths(extractFilePathsFromText(userText, projectPath), "user-input");
    addSessionFiles("referenced", [...attachmentFiles, ...inputPathFiles]);
    const sessionId = activeProjectSessionIdRef.current;
    if (!sessionId) throw new Error("请先选择或创建一个会话");
    setSessionRuntimeStatus(sessionId, { processing: true });
    try {
      await invoke("send_pi_input", { sessionId, input: `${finalPrompt}\r` });
    } catch (error) {
      setSessionRuntimeStatus(sessionId, { processing: false });
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
    if (!el) { setCommand((prev) => `${prev}${text}`); return; }
    const { nextValue, nextCursor } = insertAtCursor(el, text);
    setCommand(nextValue);
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
    else sendCommand().catch((err) => setStatus(String(err)));
  }

  function handleCommandChange(e) {
    const nextValue = e.target.value;
    setCommand(nextValue);
    const sessionId = activeProjectSessionIdRef.current;
    if (sessionId) updateSessionById(sessionId, (session) => ({ ...session, draft_command: nextValue, updated_at: new Date().toISOString() }));
  }

  function handleKeyDown(e) {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
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
          onNewSession={createProjectSession}
          onSelectSession={selectProjectSession}
          onToggleProject={toggleProject}
          onDeleteProject={deleteProject}
          onDeleteSession={deleteProjectSession}
          onRenameSession={renameProjectSession}
          onOpenProjectInExplorer={(projectId) => openProjectInExplorer(projectId).catch((e) => setStatus(String(e)))}
        />
      </aside>

      <main className="main">
        <header className="topbar">
          <span className="status">{status}</span>
          {!openedFromContext && !piStarted && (
            <textarea className="pi-start-input" value={piCommand} onChange={(e) => {
              const value = e.target.value;
              setPiCommand(value);
              const sessionId = activeProjectSessionIdRef.current;
              if (sessionId) updateSessionById(sessionId, (session) => ({ ...session, start_command: value, updated_at: new Date().toISOString() }));
            }} placeholder={'Pi 启动命令，例如：\npi --thinking high\n\n或：\n@echo off\nset DEEPSEEK_API_KEY=sk-XXXXXXXXXXXX\npi -nc %*'} />
          )}
          {!openedFromContext && (
            <button className={piStarted ? "" : "primary"} onClick={() => (piStarted ? stopPi() : startPi()).catch((e) => setStatus(String(e)))}>
              {piStarted ? <Square size={15}/> : <Play size={15}/>} {piStarted ? "停止 Pi" : "启动 Pi"}
            </button>
          )}
          <button onClick={clearTerminal}>清空输出</button>
          <button onClick={() => copyOutput().catch((e) => setStatus(`复制失败：${e}`))}><Copy size={15}/> 复制输出</button>
          <button className={terminalInputEnabled ? "primary" : ""} onClick={() => setTerminalInputEnabled((value) => !value)}>
            {terminalInputEnabled ? "原生终端：开" : "原生终端：关"}
          </button>
          <button onClick={() => sendCommand('/tree').catch((e) => setStatus(String(e)))}><GitBranch size={15}/> 发送 /tree</button>
          <button className="danger" onClick={() => stopAllPi().catch((e) => setStatus(String(e)))}>停止全部 Pi</button>
        </header>
        <div className="terminal-wrap">
          <PiTerminal
            activeSessionId={activeProjectSessionId}
            clearSignal={clearTerminalSignal}
            replaySignal={terminalReplaySignal}
            replayContent={terminalReplayContent}
            terminalInputEnabled={terminalInputEnabled}
          />
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
            <button className={isProcessing ? "danger" : "primary"} onClick={handleComposerAction}>{isProcessing ? <Square size={16}/> : <Send size={16}/>} {isProcessing ? "停止" : "发送"}</button>
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
          directoryTreeSearch={directoryTreeSearch}
          onDirectoryTreeSearchChange={setDirectoryTreeSearch}
          onToggleToolList={() => setToolListCollapsed((value) => !value)}
          onToggleDirectoryTree={() => setDirectoryTreeOpen((value) => !value)}
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
