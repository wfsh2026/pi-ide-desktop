import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Bot, Check, ChevronDown, ChevronRight, Clock3, Copy, ExternalLink, File, FileText, Loader2, MoreHorizontal, RotateCcw, Terminal } from "lucide-react";
import { buildSessionTimeline, splitMarkdownSections } from "../sessionTimelineModel.js";

function fileKey(file) {
  return file?.path || file?.name || "";
}

function uniqueFiles(files) {
  const seen = new Set();
  return (files || []).filter((file) => {
    const key = fileKey(file);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function collectTurnOutputFileKeys(turns) {
  const keys = new Set();
  for (const turn of turns || []) {
    for (const item of turn?.items || []) {
      if (item?.type !== "file_output") continue;
      for (const file of item.files || []) {
        const key = fileKey(file);
        if (key) keys.add(key);
      }
    }
  }
  return keys;
}

function latestCompletedTurnId(turns) {
  const list = Array.isArray(turns) ? turns : [];
  for (let index = list.length - 1; index >= 0; index -= 1) {
    if (list[index]?.status !== "running") return list[index].id;
  }
  return list[list.length - 1]?.id || null;
}

const TIMELINE_ESTIMATED_TURN_HEIGHT = 220;
const TIMELINE_OVERSCAN = 6;

function isNearScrollBottom(element) {
  if (!element) return true;
  return element.scrollHeight - element.scrollTop - element.clientHeight <= 24;
}

function timelineWindowRange(scrollTop, viewportHeight, count) {
  if (count <= 0) return { start: 0, end: 0, before: 0, after: 0 };
  const visible = Math.ceil(Math.max(1, viewportHeight) / TIMELINE_ESTIMATED_TURN_HEIGHT);
  const start = Math.max(0, Math.floor(scrollTop / TIMELINE_ESTIMATED_TURN_HEIGHT) - TIMELINE_OVERSCAN);
  const end = Math.min(count, start + visible + TIMELINE_OVERSCAN * 2);
  return {
    start,
    end,
    before: start * TIMELINE_ESTIMATED_TURN_HEIGHT,
    after: Math.max(0, (count - end) * TIMELINE_ESTIMATED_TURN_HEIGHT)
  };
}

function fileExt(file) {
  const name = String(file?.name || file?.path || "");
  const ext = name.includes(".") ? name.split(".").pop().toUpperCase() : "FILE";
  return ext || "FILE";
}

function fileLabel(file) {
  const ext = fileExt(file);
  if (["MD", "TXT", "DOC", "DOCX", "PDF"].includes(ext)) return `文档 · ${ext}`;
  if (["JS", "JSX", "TS", "TSX", "RS", "PY", "CSS", "HTML", "JSON"].includes(ext)) return `代码 · ${ext}`;
  return `文件 · ${ext}`;
}

function formatDuration(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const min = Math.floor(total / 60);
  const sec = total % 60;
  if (min <= 0) return `${sec}s`;
  return `${min}m ${sec}s`;
}

function formatModel(model) {
  if (!model) return "";
  const name = model.name || model.id || model.model || "";
  const provider = model.provider || "";
  if (!name && !provider) return "";
  return provider ? `${name} via ${provider}` : name;
}

function elapsedText(turn, active, hasVisibleWork, now) {
  const start = turn.createdAt ? new Date(turn.createdAt).getTime() : now;
  const end = active ? now : (turn.updatedAt ? new Date(turn.updatedAt).getTime() : now);
  if (active && !hasVisibleWork && end - start < 3000) return "正在思考";
  return `已处理 ${formatDuration(end - start)}`;
}

function copyText(text) {
  navigator.clipboard?.writeText(String(text || "")).catch(() => {});
}

function InlineText({ text }) {
  const parts = String(text || "").split(/(`[^`]+`)/g);
  return (
    <>
      {parts.map((part, index) => {
        if (part.startsWith("`") && part.endsWith("`")) {
          return <code className="pi-session-inline-code" key={index}>{part.slice(1, -1)}</code>;
        }
        return <React.Fragment key={index}>{part}</React.Fragment>;
      })}
    </>
  );
}

function MarkdownText({ text }) {
  const sections = splitMarkdownSections(text);
  if (sections.length === 0) return null;

  return (
    <div className="pi-session-markdown">
      {sections.map((section, index) => {
        if (section.type === "code") {
          return (
            <pre className="pi-session-code" key={`${section.type}-${index}`}>
              {section.language && <span>{section.language}</span>}
              <code>{section.text}</code>
            </pre>
          );
        }

        return section.text.split(/\n{2,}/).map((block, blockIndex) => {
          const value = block.trim();
          if (!value) return null;
          const heading = value.match(/^(#{1,4})\s+(.+)$/);
          if (heading) return <h4 key={`${index}-${blockIndex}`}>{heading[2]}</h4>;

          const lines = value.split("\n");
          const bulletLines = lines.filter((line) => /^[-*]\s+/.test(line.trim()));
          if (bulletLines.length > 0 && bulletLines.length === lines.length) {
            return (
              <ul key={`${index}-${blockIndex}`}>
                {bulletLines.map((line, lineIndex) => <li key={lineIndex}><InlineText text={line.trim().replace(/^[-*]\s+/, "")}/></li>)}
              </ul>
            );
          }

          const orderedLines = lines.filter((line) => /^\d+\.\s+/.test(line.trim()));
          if (orderedLines.length > 0 && orderedLines.length === lines.length) {
            return (
              <ol key={`${index}-${blockIndex}`}>
                {orderedLines.map((line, lineIndex) => <li key={lineIndex}><InlineText text={line.trim().replace(/^\d+\.\s+/, "")}/></li>)}
              </ol>
            );
          }

          return <p key={`${index}-${blockIndex}`}><InlineText text={value}/></p>;
        });
      })}
    </div>
  );
}

function collectTurnParts(turn, fallbackOutputFiles) {
  const parts = {
    user: null,
    assistantText: "",
    progress: [],
    thinking: [],
    commands: [],
    references: [],
    outputs: [],
    errors: []
  };

  for (const item of turn.items || []) {
    if (item.type === "user_message") parts.user = item;
    else if (item.type === "assistant_message") parts.assistantText += item.text || "";
    else if (item.type === "progress") parts.progress.push(item);
    else if (item.type === "thinking") parts.thinking.push(item);
    else if (item.type === "command") parts.commands.push(item);
    else if (item.type === "file_reference") parts.references.push(...(item.files || []));
    else if (item.type === "file_output") parts.outputs.push(...(item.files || []));
    else if (item.type === "error") parts.errors.push(item);
  }

  parts.references = uniqueFiles(parts.references);
  parts.outputs = uniqueFiles(parts.outputs.length ? parts.outputs : fallbackOutputFiles);
  return parts;
}

function UserMessage({ item }) {
  if (!item) return null;
  return (
    <div className="pi-session-user-message">
      <div className="pi-session-user-bubble">
        <MarkdownText text={item.text}/>
      </div>
      <button className="pi-session-mini-action" title="复制" onClick={() => copyText(item.text)}>
        <Copy size={13}/>
      </button>
    </div>
  );
}

function StatusLine({ label, expanded, canExpand, onToggle }) {
  const content = (
    <>
      <span>{label}</span>
      {canExpand && (expanded ? <ChevronDown size={13}/> : <ChevronRight size={13}/>)}
    </>
  );

  if (!canExpand) return <div className="pi-session-status-line">{content}</div>;
  return <button className="pi-session-status-line interactive" onClick={onToggle}>{content}</button>;
}

function OperationRecords({ items }) {
  const records = (items || []).filter((item) => item?.title);
  if (records.length === 0) return null;
  return (
    <div className="pi-session-operation-list">
      {records.map((item) => (
        <div className={`pi-session-operation-row ${item.status || ""}`} key={item.id}>
          {item.status === "running" ? <Loader2 className="spin" size={13}/> : <Check size={13}/>}
          <span>{item.title}</span>
          {item.detail && <small>{item.detail}</small>}
        </div>
      ))}
    </div>
  );
}

function OutputFileCard({ file, onOpenFile, onOpenDirectory }) {
  return (
    <div className="pi-session-output-file-card">
      <div className="pi-session-file-icon"><FileText size={18}/></div>
      <div className="pi-session-file-meta">
        <strong>{file.name || file.path}</strong>
        <small>{fileLabel(file)}</small>
      </div>
      <button
        className="pi-session-open-file"
        onClick={() => onOpenFile?.(file)}
        onContextMenu={(event) => {
          event.preventDefault();
          onOpenDirectory?.(file);
        }}
      >
        打开 <ChevronDown size={13}/>
      </button>
    </div>
  );
}

function ChangeSummary({ files, onOpenFile }) {
  if (files.length === 0) return null;
  return (
    <div className="pi-session-change-card">
      <div className="pi-session-change-head">
        <strong>{files.length} 个文件已更改</strong>
        <div>
          <button title="撤销"><RotateCcw size={13}/>撤销</button>
          <button title="审核"><ExternalLink size={13}/>审核</button>
          <button title="更多"><MoreHorizontal size={14}/></button>
        </div>
      </div>
      {files.map((file) => (
        <button className="pi-session-change-row" key={file.path || file.name} onClick={() => onOpenFile?.(file)}>
          <span>{file.path || file.name}</span>
          <small>{file.additions != null ? `+${file.additions}` : "已更改"}{file.deletions != null ? ` -${file.deletions}` : ""}</small>
          <ChevronDown size={13}/>
        </button>
      ))}
    </div>
  );
}

function CommandDetails({ commands, expandedCommands, onToggleCommand }) {
  if (commands.length === 0) return null;
  return (
    <div className="pi-session-detail-block">
      <div className="pi-session-detail-title"><Terminal size={14}/> 已运行 {commands.length} 条命令</div>
      {commands.map((command, index) => {
        const id = command.id || `command-${index}`;
        const expanded = expandedCommands.has(id);
        return (
          <div className="pi-session-command-detail" key={id}>
            <button className="pi-session-command-toggle" onClick={() => onToggleCommand(id)}>
              {expanded ? <ChevronDown size={13}/> : <ChevronRight size={13}/>}
              {command.status === "running" ? `正在运行 ${command.command}` : "已运行命令"}
            </button>
            {expanded && (
              <div className="pi-session-shell-card">
                <div className="pi-session-shell-label">Shell</div>
                <pre><code>{command.cwd ? `${command.cwd}> ${command.command}` : `$ ${command.command}`}{command.output ? `\n\n${command.output}` : ""}</code></pre>
                <div className={command.exitCode && command.exitCode !== 0 ? "pi-session-shell-result danger" : "pi-session-shell-result"}>
                  <Check size={13}/> {command.exitCode && command.exitCode !== 0 ? `失败 ${command.exitCode}` : "成功"}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function FileDetailList({ title, files }) {
  if (files.length === 0) return null;
  return (
    <div className="pi-session-detail-block">
      <div className="pi-session-detail-title"><File size={14}/> {title} {files.length} 个文件</div>
      <div className="pi-session-detail-files">
        {files.map((file) => <span key={file.path || file.name}>{file.name || file.path}</span>)}
      </div>
    </div>
  );
}

function TurnDetails({ parts, expandedCommands, onToggleCommand }) {
  const hasDetails = parts.commands.length || parts.references.length || parts.progress.length || parts.thinking.length || parts.errors.length;
  if (!hasDetails) return null;

  return (
    <div className="pi-session-turn-details">
      <CommandDetails commands={parts.commands} expandedCommands={expandedCommands} onToggleCommand={onToggleCommand}/>
      <FileDetailList title="已读取" files={parts.references}/>
      {parts.progress.length > 0 && (
        <div className="pi-session-detail-block">
          <div className="pi-session-detail-title"><Loader2 size={14}/> 处理过程</div>
          {parts.progress.map((item) => <div className="pi-session-detail-note" key={item.id}>{item.title}{item.detail ? `：${item.detail}` : ""}</div>)}
        </div>
      )}
      {parts.thinking.length > 0 && (
        <div className="pi-session-detail-block">
          <div className="pi-session-detail-title"><Bot size={14}/> 思考过程</div>
          {parts.thinking.map((item) => <pre className="pi-session-code" key={item.id}><code>{item.text}</code></pre>)}
        </div>
      )}
      {parts.errors.map((error) => (
        <div className="pi-session-detail-block danger" key={error.id}>
          <div className="pi-session-detail-title">{error.title}</div>
          <pre className="pi-session-code"><code>{error.detail}</code></pre>
        </div>
      ))}
    </div>
  );
}

function TurnView({ turn, runtimeStatus, fallbackOutputFiles, expanded, expandedCommands, onToggleTurn, onToggleCommand, onOpenFile, onOpenDirectory, now }) {
  const active = Boolean((runtimeStatus?.processing || runtimeStatus?.starting) && turn.status === "running");
  const parts = collectTurnParts(turn, fallbackOutputFiles);
  const hasDetails = Boolean(parts.commands.length || parts.references.length || parts.progress.length || parts.thinking.length || parts.errors.length);
  const hasVisibleWork = Boolean(parts.assistantText.trim() || parts.commands.length || parts.outputs.length || parts.errors.length);
  const status = elapsedText(turn, active, hasVisibleWork, now);

  return (
    <div className="pi-session-turn">
      <UserMessage item={parts.user}/>
      <StatusLine label={status} expanded={expanded} canExpand={hasDetails} onToggle={onToggleTurn}/>
      <OperationRecords items={parts.progress}/>
      {parts.assistantText.trim() ? <MarkdownText text={parts.assistantText}/> : active ? <div className="pi-session-thinking">正在思考</div> : null}
      {parts.outputs.length > 0 && (
        <div className="pi-session-output-section">
          <strong>已输出文件：</strong>
          <div className="pi-session-output-links">
            {parts.outputs.map((file) => <button key={file.path || file.name} onClick={() => onOpenFile?.(file)}><File size={13}/>{file.name || file.path}</button>)}
          </div>
          {parts.outputs.map((file) => <OutputFileCard key={file.path || file.name} file={file} onOpenFile={onOpenFile} onOpenDirectory={onOpenDirectory}/>)}
          <ChangeSummary files={parts.outputs} onOpenFile={onOpenFile}/>
        </div>
      )}
      {expanded && <TurnDetails parts={parts} expandedCommands={expandedCommands} onToggleCommand={onToggleCommand}/>}
    </div>
  );
}

export default function SessionTimeline({ project, session, runtimeStatus, onOpenFile, onOpenDirectory }) {
  const viewportRef = useRef(null);
  const shouldAutoScrollRef = useRef(true);
  const [visibleRange, setVisibleRange] = useState(() => timelineWindowRange(0, 800, 0));
  const [expandedTurns, setExpandedTurns] = useState(() => new Set());
  const [expandedCommands, setExpandedCommands] = useState(() => new Set());
  const [now, setNow] = useState(Date.now());
  const turns = useMemo(() => buildSessionTimeline(session), [session]);
  const active = Boolean(runtimeStatus?.processing || runtimeStatus?.starting);
  const turnOutputFileKeys = useMemo(() => collectTurnOutputFileKeys(turns), [turns]);
  const fallbackOutputFiles = useMemo(() => uniqueFiles(session?.output_files || [])
    .filter((file) => !turnOutputFileKeys.has(fileKey(file))), [session?.output_files, turnOutputFileKeys]);
  const fallbackOutputTurnId = useMemo(() => latestCompletedTurnId(turns), [turns]);
  const modelLabel = formatModel(runtimeStatus?.model || session?.current_model);
  const visibleTurns = useMemo(() => turns.slice(visibleRange.start, visibleRange.end), [turns, visibleRange.start, visibleRange.end]);

  function updateVisibleRange() {
    const el = viewportRef.current;
    if (!el) {
      setVisibleRange(timelineWindowRange(0, 800, turns.length));
      return;
    }
    const next = timelineWindowRange(el.scrollTop, el.clientHeight, turns.length);
    setVisibleRange((prev) => (
      prev.start === next.start && prev.end === next.end && prev.before === next.before && prev.after === next.after
        ? prev
        : next
    ));
  }

  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);

  useLayoutEffect(() => {
    updateVisibleRange();
  }, [turns.length]);

  useEffect(() => {
    shouldAutoScrollRef.current = true;
    window.requestAnimationFrame(() => {
      if (viewportRef.current) {
        viewportRef.current.scrollTop = viewportRef.current.scrollHeight;
        updateVisibleRange();
      }
    });
  }, [session?.id]);

  useEffect(() => {
    if (!active || !viewportRef.current || !shouldAutoScrollRef.current) return;
    viewportRef.current.scrollTop = viewportRef.current.scrollHeight;
    updateVisibleRange();
  }, [active, session?.output, session?.updated_at, turns.length]);

  function handleViewportScroll(event) {
    shouldAutoScrollRef.current = isNearScrollBottom(event.currentTarget);
    updateVisibleRange();
  }

  function toggleTurn(id) {
    setExpandedTurns((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleCommand(id) {
    setExpandedCommands((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  if (!session) {
    return (
      <div className="session-view pi-session-view">
        <div className="session-empty-state">
          <Clock3 size={20}/>
          <strong>未选择会话</strong>
          <span>请先在左侧选择或创建一个 Pi 会话。</span>
        </div>
      </div>
    );
  }

  return (
    <div className="session-view pi-session-view">
      <div className="session-view-header">
        <div>
          <strong>{session.title || "新 Pi 会话"}</strong>
          <small>{[project?.name || "未选择项目", modelLabel ? `模型：${modelLabel}` : ""].filter(Boolean).join(" · ")}</small>
        </div>
        <span className={`timeline-status ${active ? "active" : ""}`}>
          {active ? <Loader2 className="spin" size={14}/> : <Bot size={14}/>}
          {active ? "处理中" : "已完成"}
        </span>
      </div>

      <div className="session-timeline pi-session-stream" ref={viewportRef} onScroll={handleViewportScroll}>
        {turns.length === 0 ? (
          <div className="session-empty-state">
            <Bot size={20}/>
            <strong>会话尚未开始</strong>
            <span>在下方输入任务后，这里会按结构化风格整理展示。</span>
          </div>
        ) : (
          <>
            {visibleRange.before > 0 && <div className="timeline-virtual-spacer" style={{ height: visibleRange.before }} />}
            {visibleTurns.map((turn, localIndex) => {
              const index = visibleRange.start + localIndex;
              return (
                <TurnView
                  key={turn.id}
                  turn={turn}
                  runtimeStatus={index === turns.length - 1 ? runtimeStatus : null}
                  fallbackOutputFiles={turn.id === fallbackOutputTurnId ? fallbackOutputFiles : []}
                  expanded={expandedTurns.has(turn.id)}
                  expandedCommands={expandedCommands}
                  onToggleTurn={() => toggleTurn(turn.id)}
                  onToggleCommand={toggleCommand}
                  onOpenFile={onOpenFile}
                  onOpenDirectory={onOpenDirectory}
                  now={now}
                />
              );
            })}
            {visibleRange.after > 0 && <div className="timeline-virtual-spacer" style={{ height: visibleRange.after }} />}
          </>
        )}
      </div>
    </div>
  );
}
