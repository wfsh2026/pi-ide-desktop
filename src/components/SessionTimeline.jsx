import React, { useEffect, useMemo, useRef, useState } from "react";
import { Bot, Check, ChevronDown, ChevronRight, Clock3, Copy, File, FileText, Loader2, Wrench } from "lucide-react";
import {
  buildProcessView,
  commandDisplayLabel,
  commandToolIcon,
  filterProcessSteps,
  processFilterOptions,
  processSummaryText,
  shouldAutoExpandProcessStep
} from "../processTimelineModel.js";
import { buildResultView, resultStatusLabel, verificationSummary } from "../resultTimelineModel.js";
import { buildSessionTimeline, splitMarkdownSections } from "../sessionTimelineModel.js";
import { isTableRow, isTableSeparator, parseTableCells, tableStartsAt } from "../sessionMarkdownTableModel.js";

// ─── Helpers ────────────────────────────────────────────────────────

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

function isNearScrollBottom(element) {
  if (!element) return true;
  return element.scrollHeight - element.scrollTop - element.clientHeight <= 24;
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
  if (ms == null) return "";
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

function durationText(ms) {
  const value = formatDuration(ms);
  return value ? value : "";
}

function copyText(text) {
  navigator.clipboard?.writeText(String(text || "")).catch(() => {});
}

// ─── Inline Markdown ─────────────────────────────────────────────────

function parseInlineTokens(text) {
  const value = String(text || "");
  if (!value) return [];
  const tokenPattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|(__[^_]+__)|(\*[^*]+\*)|(_[^_]+_)|(~~[^~]+~~)|(\[[^\]]+\]\([^)]+\))/g;
  const tokens = [];
  let lastIndex = 0;
  let match;
  while ((match = tokenPattern.exec(value)) !== null) {
    if (match.index > lastIndex) tokens.push({ type: "text", text: value.slice(lastIndex, match.index) });
    const raw = match[0];
    if (raw.startsWith("`") && raw.endsWith("`")) {
      tokens.push({ type: "code", text: raw.slice(1, -1) });
    } else if ((raw.startsWith("**") && raw.endsWith("**")) || (raw.startsWith("__") && raw.endsWith("__"))) {
      tokens.push({ type: "bold", text: raw.slice(2, -2) });
    } else if (raw.startsWith("~~") && raw.endsWith("~~")) {
      tokens.push({ type: "strikethrough", text: raw.slice(2, -2) });
    } else if (raw.startsWith("*") && raw.endsWith("*")) {
      tokens.push({ type: "italic", text: raw.slice(1, -1) });
    } else if (raw.startsWith("_") && raw.endsWith("_")) {
      tokens.push({ type: "italic", text: raw.slice(1, -1) });
    } else if (raw.startsWith("[")) {
      const linkMatch = raw.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      if (linkMatch) tokens.push({ type: "link", text: linkMatch[1], href: linkMatch[2] });
      else tokens.push({ type: "text", text: raw });
    }
    lastIndex = tokenPattern.lastIndex;
  }
  if (lastIndex < value.length) tokens.push({ type: "text", text: value.slice(lastIndex) });
  return tokens;
}

function InlineText({ text }) {
  const tokens = useMemo(() => parseInlineTokens(text), [text]);
  if (tokens.length === 0) return null;
  return (
    <>
      {tokens.map((token, i) => {
        switch (token.type) {
          case "code": return <code className="pi-session-inline-code" key={i}>{token.text}</code>;
          case "bold": return <strong key={i}>{token.text}</strong>;
          case "italic": return <em key={i}>{token.text}</em>;
          case "strikethrough": return <s key={i}>{token.text}</s>;
          case "link": return <a className="pi-session-link" key={i} href={token.href} target="_blank" rel="noopener noreferrer">{token.text}</a>;
          default: return <React.Fragment key={i}>{token.text}</React.Fragment>;
        }
      })}
    </>
  );
}

// ─── Block Markdown ──────────────────────────────────────────────────

function renderTable(lines, key) {
  const rows = lines.map(parseTableCells);
  const columnCount = Math.max(...rows.map((r) => r.length));
  const hasSep = lines.length > 1 && isTableSeparator(lines[1]);
  const hdr = rows[0];
  const body = rows.slice(hasSep ? 2 : 1);
  const cellAt = (row, i) => row[i] ?? "";
  return (
    <div className="pi-session-table-wrap" key={key}>
      <table className="pi-session-table">
        <thead><tr>{Array.from({ length: columnCount }, (_, ci) => <th key={ci}><InlineText text={cellAt(hdr, ci)}/></th>)}</tr></thead>
        <tbody>{body.map((r, ri) => <tr key={ri}>{Array.from({ length: columnCount }, (_, ci) => <td key={ci}><InlineText text={cellAt(r, ci)}/></td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}

function renderPlainMarkdownBlock(value, key) {
  const lines = value.split("\n");
  const h = value.match(/^(#{1,4})\s+(.+)$/);
  if (h) return <h4 key={key}>{h[2]}</h4>;

  const ql = lines.filter((l) => /^>\s?/.test(l.trim()));
  if (ql.length > 0 && ql.length === lines.length) {
    return (
      <blockquote className="pi-session-blockquote" key={key}>
        <InlineText text={ql.map((l) => l.trim().replace(/^>\s?/, "")).join("\n")}/>
      </blockquote>
    );
  }

  const tl = lines.filter((l) => /^[-*]\s+\[[ xX]\]\s+/.test(l.trim()));
  if (tl.length > 0 && tl.length === lines.length) {
    return (
      <ul className="pi-session-task-list" key={key}>
        {tl.map((l, li) => {
          const ck = /\[[xX]\]/.test(l);
          const ct = l.trim().replace(/^[-*]\s+\[[ xX]\]\s+/, "");
          return <li key={li} className={ck ? "checked" : ""}><span className="pi-session-task-check">{ck ? "☑" : "☐"}</span><InlineText text={ct}/></li>;
        })}
      </ul>
    );
  }

  const bl = lines.filter((l) => /^[-*]\s+/.test(l.trim()));
  if (bl.length > 0 && bl.length === lines.length) {
    return <ul key={key}>{bl.map((l, li) => <li key={li}><InlineText text={l.trim().replace(/^[-*]\s+/, "")}/></li>)}</ul>;
  }

  const ol = lines.filter((l) => /^\d+\.\s+/.test(l.trim()));
  if (ol.length > 0 && ol.length === lines.length) {
    return <ol key={key}>{ol.map((l, li) => <li key={li}><InlineText text={l.trim().replace(/^\d+\.\s+/, "")}/></li>)}</ol>;
  }

  return <p key={key}><InlineText text={value}/></p>;
}

function renderTextSection(text, keyPrefix) {
  const lines = String(text || "").split("\n");
  const out = [];
  let pg = [];
  let i = 0;
  function flush() { const v = pg.join("\n").trim(); if (v) out.push(renderPlainMarkdownBlock(v, `${keyPrefix}-p-${out.length}`)); pg = []; }
  while (i < lines.length) {
    const ln = lines[i];
    if (!ln.trim()) { flush(); i += 1; continue; }
    if (tableStartsAt(lines, i)) {
      flush();
      const tbl = [lines[i], lines[i + 1]]; i += 2;
      while (i < lines.length && isTableRow(lines[i]) && !isTableSeparator(lines[i])) { tbl.push(lines[i]); i += 1; }
      out.push(renderTable(tbl, `${keyPrefix}-table-${out.length}`));
      continue;
    }
    if (isTableRow(ln)) {
      const tbl = []; let c = i;
      while (c < lines.length && isTableRow(lines[c]) && !isTableSeparator(lines[c])) { tbl.push(lines[c]); c += 1; }
      if (tbl.length >= 2) { flush(); out.push(renderTable(tbl, `${keyPrefix}-pipe-${out.length}`)); i = c; continue; }
    }
    pg.push(ln); i += 1;
  }
  flush();
  return out;
}

function MarkdownText({ text }) {
  const sections = useMemo(() => splitMarkdownSections(text), [text]);
  if (sections.length === 0) return null;
  return (
    <div className="pi-session-markdown">
      {sections.map((sec, i) => sec.type === "code"
        ? <pre className="pi-session-code" key={`${sec.type}-${i}`}>{sec.language && <span>{sec.language}</span>}<code>{sec.text}</code></pre>
        : renderTextSection(sec.text, `${sec.type}-${i}`)
      )}
    </div>
  );
}

// ─── Turn Parts ──────────────────────────────────────────────────────

function collectTurnParts(turn, fallbackOutputFiles) {
  const parts = { user: null, conclusion: "", processItems: [], subagents: [], references: [], outputs: [], errors: [] };
  for (const item of turn.items || []) {
    if (item.type === "user_message") parts.user = item;
    else if (item.type === "assistant_message") parts.conclusion = item.text || "";
    else if (item.type === "note" || item.type === "thinking" || item.type === "command" || item.type === "progress") parts.processItems.push(item);
    else if (item.type === "subagent_group") parts.subagents.push(item);
    else if (item.type === "file_reference") parts.references.push(...(item.files || []));
    else if (item.type === "file_output") parts.outputs.push(...(item.files || []));
    else if (item.type === "error") {
      parts.processItems.push(item);
      parts.errors.push(item);
    }
  }
  parts.references = uniqueFiles(parts.references);
  parts.outputs = uniqueFiles(parts.outputs.length ? parts.outputs : fallbackOutputFiles);
  return parts;
}

// ─── Components ──────────────────────────────────────────────────────

function UserMessage({ item }) {
  if (!item) return null;
  return (
    <div className="pi-session-user-message">
      <div className="pi-session-user-bubble"><MarkdownText text={item.text}/></div>
      <button className="pi-session-mini-action" title="复制" onClick={() => copyText(item.text)}><Copy size={13}/></button>
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
      <button className="pi-session-open-file" onClick={() => onOpenFile?.(file)} onContextMenu={(e) => { e.preventDefault(); onOpenDirectory?.(file); }}>
        打开 <ChevronDown size={13}/>
      </button>
    </div>
  );
}

function ChangeSummary({ files, onOpenFile }) {
  if (files.length === 0) return null;
  return (
    <div className="pi-session-change-card">
      <div className="pi-session-change-head"><strong>{files.length} 个文件已更改</strong></div>
      {files.map((f) => (
        <button className="pi-session-change-row" key={f.path || f.name} onClick={() => onOpenFile?.(f)}>
          <span>{f.path || f.name}</span>
          <small>{f.additions != null ? `+${f.additions}` : "已更改"}{f.deletions != null ? ` -${f.deletions}` : ""}</small>
          <ChevronDown size={13}/>
        </button>
      ))}
    </div>
  );
}

function VerificationItem({ item }) {
  const failed = item.status === "failed";
  const running = item.status === "running";
  return (
    <div className={`pi-session-verification-row ${item.status}`} key={item.id}>
      {running ? <Loader2 className="spin" size={13}/> : failed ? <span className="pi-session-verification-fail">!</span> : <Check size={13}/>}
      <code>{item.command}</code>
      <small>{failed ? `失败${item.exitCode != null ? ` ${item.exitCode}` : ""}` : running ? "运行中" : "通过"}</small>
    </div>
  );
}

function ResultSection({ result, onOpenFile, onOpenDirectory }) {
  if (!result?.hasContent) return null;
  const hasConclusion = Boolean(result.conclusion);
  const hasVerifications = result.verifications.length > 0;
  const hasFiles = result.files.length > 0;

  return (
    <div className="pi-session-result-section">
      <div className="pi-session-result-head">
        <strong>结果</strong>
        <span className={`pi-session-result-status ${result.status}`}>{resultStatusLabel(result.status)}</span>
      </div>

      {hasConclusion && (
        <div className="pi-session-result-block">
          <div className="pi-session-result-title">最终答复</div>
          <MarkdownText text={result.conclusion}/>
        </div>
      )}

      <div className="pi-session-result-block compact">
        <div className="pi-session-result-title">验证结果</div>
        <div className={`pi-session-verification-summary ${result.status}`}>{verificationSummary(result.verifications)}</div>
        {hasVerifications && (
          <div className="pi-session-verification-list">
            {result.verifications.map((item) => <VerificationItem item={item} key={item.id}/>)}
          </div>
        )}
      </div>

      {hasFiles && (
        <div className="pi-session-result-block">
          <div className="pi-session-result-title">文件变更</div>
          <div className="pi-session-output-links">
            {result.files.map((f) => <button key={f.path || f.name} onClick={() => onOpenFile?.(f)}><File size={13}/>{f.name || f.path}</button>)}
          </div>
          {result.files.map((f) => <OutputFileCard key={f.path || f.name} file={f} onOpenFile={onOpenFile} onOpenDirectory={onOpenDirectory}/>)}
          <ChangeSummary files={result.files} onOpenFile={onOpenFile}/>
        </div>
      )}
    </div>
  );
}

// ─── Thinking Round ──────────────────────────────────────────────────

function ThinkingInlinePreview({ text }) {
  return <span className="pi-session-thinking-preview">{text}</span>;
}

function SubagentInlineNotice({ groups }) {
  const runs = groups.flatMap((group) => group.runs || []);
  if (runs.length === 0) return null;
  const running = runs.filter((run) => run.status === "running").length;
  const failed = runs.filter((run) => run.status === "failed").length;
  const detail = running > 0 ? `${running} 运行中` : failed > 0 ? `${failed} 失败` : "已完成";
  return (
    <div className="pi-session-subagent-inline">
      <Bot size={14}/>
      <span>已启动 {runs.length} 个 Subagent</span>
      <small>{detail}，详情在工具栏的会话文件中查看</small>
    </div>
  );
}

function ThinkingRound({ thinking, isActive, isDone, roundIndex, canCollapse, onToggle }) {
  const text = String(thinking.text || "").trim();
  const roundLabel = thinking.title || `思考过程 ${roundIndex}`;
  const elapsed = durationText(thinking.durationMs);
  if (!text && !isActive) return null;

  return (
    <div className={`pi-session-thinking-round ${isActive ? "active" : ""} ${isDone ? "done" : ""}`}>
      <div className="pi-session-thinking-round-head">
        {canCollapse && <button className="pi-session-thinking-collapse" onClick={onToggle}><ChevronDown size={13}/></button>}
        <Bot size={14}/>
        <span>{roundLabel}</span>
        <small className="pi-session-thinking-round-status">
          {elapsed && <span>{elapsed}</span>}
          {isActive ? <><Loader2 className="spin" size={12}/> 思考中</> : isDone ? <><Check size={12}/> 已完成</> : null}
        </small>
      </div>
      {text && <div className="pi-session-thinking-round-body">{text}</div>}
      {!text && isActive && <div className="pi-session-thinking-round-body pi-session-thinking-pending">…</div>}
    </div>
  );
}

// ─── Tool Call Item ──────────────────────────────────────────────────

function ToolIcon({ item, running }) {
  if (running) return <Loader2 className="spin" size={13}/>;
  const type = commandToolIcon(item);
  return <Wrench size={13} data-tool-type={type}/>;
}

function ToolCallItem({ item, expanded, onToggle }) {
  const running = item.status === "running";
  const exitOk = item.exitCode != null && item.exitCode === 0;
  const exitFail = item.exitCode != null && item.exitCode !== 0;
  const label = commandDisplayLabel(item);
  const elapsed = durationText(item.durationMs);

  return (
    <div className={`pi-session-toolcall-item ${running ? "running" : "done"} ${item.kind === "subagent" ? "subagent" : ""}`}>
      <button className="pi-session-toolcall-toggle" onClick={onToggle}>
        {expanded ? <ChevronDown size={13}/> : <ChevronRight size={13}/>}
        <span className="pi-session-toolcall-icon"><ToolIcon item={item} running={running}/></span>
        <span className="pi-session-toolcall-label">{label}</span>
        {elapsed && <span className="pi-session-toolcall-duration">{elapsed}</span>}
        <span className="pi-session-toolcall-status">
          {running ? <Loader2 className="spin" size={12}/> : exitOk ? <Check size={12}/> : exitFail ? <span className="pi-session-cmd-fail">失败 {item.exitCode}</span> : <Check size={12}/>}
        </span>
      </button>
      {expanded && (
        <div className="pi-session-shell-card">
          <div className="pi-session-shell-label">{item.kind === "subagent" ? "Subagent" : (item.toolName || "Tool")}</div>
          <pre><code>{item.cwd ? `${item.cwd}> ${item.command}` : `$ ${item.command}`}{item.output ? `\n\n${item.output}` : ""}</code></pre>
          <div className={exitFail ? "pi-session-shell-result danger" : "pi-session-shell-result"}>
            <Check size={13}/> {exitFail ? `失败 ${item.exitCode}` : exitOk ? "成功" : running ? "运行中" : "完成"}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Tool Call Group ─────────────────────────────────────────────────

function toolGroupSummary(commands) {
  const subagents = commands.filter((item) => item.kind === "subagent").length;
  const tools = commands.length - subagents;
  const parts = [];
  if (tools) parts.push(`${tools} 个工具`);
  if (subagents) parts.push(`${subagents} 个子代理`);
  return parts.join(" · ") || "工具调用";
}

function ToolCallGroup({ commands, isActive, expandedCommands, onToggleCommand }) {
  if (commands.length === 0) return null;
  const summary = toolGroupSummary(commands);
  const allDone = commands.every((c) => c.status !== "running");
  const runningCmd = commands.find((c) => c.status === "running");
  const groupId = `group-${commands[0]?.id}`;
  const groupExpanded = expandedCommands.has(groupId) || commands.some((item) => shouldAutoExpandProcessStep(item, isActive));

  // When the group is active (current round), show inline
  if (isActive) {
    return (
      <div className={`pi-session-toolcall-group ${allDone ? "done" : "active"}`}>
        <div className="pi-session-toolcall-group-head">
          <Wrench size={13}/>
          <span>{allDone ? summary : (runningCmd ? `正在 ${commandDisplayLabel(runningCmd)}` : summary)}</span>
        </div>
        <div className="pi-session-toolcall-group-items">
          {commands.map((c) => (
            <ToolCallItem key={c.id} item={c} expanded={expandedCommands.has(c.id) || shouldAutoExpandProcessStep(c, true)} onToggle={() => onToggleCommand(c.id)}/>
          ))}
        </div>
      </div>
    );
  }

  // Completed group: collapsed by default
  return (
    <div className="pi-session-toolcall-group done">
      <button className="pi-session-toolcall-group-summary" onClick={() => onToggleCommand(groupId)}>
        {groupExpanded ? <ChevronDown size={13}/> : <ChevronRight size={13}/>}
        <span className="pi-session-toolcall-icon">{allDone ? <Check size={13}/> : <Loader2 className="spin" size={13}/>}</span>
        <span>{summary}</span>
      </button>
      {groupExpanded && (
        <div className="pi-session-toolcall-group-items">
          {commands.map((c) => (
            <ToolCallItem key={c.id} item={c} expanded={expandedCommands.has(c.id) || shouldAutoExpandProcessStep(c, false)} onToggle={() => onToggleCommand(c.id)}/>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Process Section ─────────────────────────────────────────────────

function SystemProcessStep({ step }) {
  return (
    <div className={`pi-session-op-row ${step.status}`} key={step.id}>
      {step.status === "running" ? <Loader2 className="spin" size={13}/> : <Check size={13}/>}
      <span>{step.title}</span>
      {durationText(step.durationMs) && <small>{durationText(step.durationMs)}</small>}
      {step.detail && <small>{step.detail}</small>}
    </div>
  );
}

function ErrorProcessStep({ step }) {
  return (
    <div className="pi-session-error-block" key={step.id}>
      <div className="pi-session-error-title">{step.title}</div>
      {step.detail && <pre className="pi-session-code"><code>{step.detail}</code></pre>}
    </div>
  );
}

function NoteProcessStep({ step }) {
  return (
    <div className="pi-session-process-note" key={step.id}>
      <div className="pi-session-process-note-title">{step.title}</div>
      <div className="pi-session-process-note-body"><MarkdownText text={step.text}/></div>
    </div>
  );
}

function renderProcessSteps(steps, isRunning, expandedCommands, onToggleCommand) {
  const output = [];
  let toolGroup = [];

  function flushToolGroup() {
    if (toolGroup.length === 0) return;
    const group = toolGroup;
    toolGroup = [];
    output.push(
      <ToolCallGroup
        key={`tools-${group[0].id}`}
        commands={group}
        isActive={isRunning && group.some((step) => step.status === "running")}
        expandedCommands={expandedCommands}
        onToggleCommand={onToggleCommand}
      />
    );
  }

  steps.forEach((step, index) => {
    if (step.kind === "tool" || step.kind === "subagent") {
      toolGroup.push(step);
      return;
    }
    flushToolGroup();
    if (step.kind === "thinking") {
      const autoExpanded = shouldAutoExpandProcessStep(step, isRunning);
      const expanded = autoExpanded || expandedCommands.has(step.id);
      output.push(
        <div className="pi-session-thinking-wrap" key={step.id}>
          {!expanded && (
            <button className="pi-session-thinking-summary" onClick={() => onToggleCommand(step.id)}>
              <ChevronRight size={13}/>
              <Bot size={13}/>
              <span>{step.title || `思考过程 ${step.round || index + 1}`}</span>
              {durationText(step.durationMs) && <small>{durationText(step.durationMs)}</small>}
            </button>
          )}
          {expanded && (
            <ThinkingRound
              thinking={step}
              isActive={isRunning && step.status === "running"}
              isDone={step.status !== "running"}
              roundIndex={step.round || index + 1}
              canCollapse={!autoExpanded}
              onToggle={() => onToggleCommand(step.id)}
            />
          )}
        </div>
      );
    } else if (step.kind === "error") {
      output.push(<ErrorProcessStep step={step} key={step.id}/>);
    } else if (step.kind === "note") {
      output.push(<NoteProcessStep step={step} key={step.id}/>);
    } else {
      output.push(<SystemProcessStep step={step} key={step.id}/>);
    }
  });

  flushToolGroup();
  return output;
}

function ProcessSection({ processItems, turnStatus, expanded, expandedCommands, onToggleTurn, onToggleCommand }) {
  const [filter, setFilter] = useState("all");
  const processView = useMemo(() => buildProcessView(processItems, turnStatus), [processItems, turnStatus]);
  if (processView.steps.length === 0) return null;
  const isRunning = processView.status === "running";
  const summary = processSummaryText(processView);
  const filterOptions = processFilterOptions(processView);
  const visibleSteps = filterProcessSteps(processView.steps, filter);
  const showFilters = filterOptions.length > 2;
  const filterBar = showFilters ? (
    <div className="pi-session-process-filters">
      {filterOptions.map((option) => (
        <button key={option.id} className={filter === option.id ? "active" : ""} onClick={() => setFilter(option.id)}>
          <span>{option.label}</span>
          <small>{option.count}</small>
        </button>
      ))}
    </div>
  ) : null;

  if (isRunning) {
    return (
      <div className="pi-session-process-section">
        {filterBar}
        {renderProcessSteps(visibleSteps, true, expandedCommands, onToggleCommand)}
      </div>
    );
  }

  return (
    <div className="pi-session-process-section pi-session-process-done">
      <button className="pi-session-process-summary" onClick={onToggleTurn}>
        {expanded ? <ChevronDown size={14}/> : <ChevronRight size={14}/>}
        <Bot size={14}/>
        <span>{summary}</span>
        <small>点击{expanded ? "收起" : "展开"}详情</small>
      </button>
      {expanded && (
        <div className="pi-session-process-details">
          {filterBar}
          {renderProcessSteps(visibleSteps, false, expandedCommands, onToggleCommand)}
        </div>
      )}
    </div>
  );
}

// ─── Turn View ───────────────────────────────────────────────────────

function TurnView({ turn, runtimeStatus, fallbackOutputFiles, expanded, expandedCommands, onToggleTurn, onToggleCommand, onOpenFile, onOpenDirectory, now }) {
  const active = Boolean((runtimeStatus?.processing || runtimeStatus?.starting) && turn.status === "running");
  const parts = collectTurnParts(turn, fallbackOutputFiles);
  const hasProcess = parts.processItems.length > 0;
  const result = useMemo(() => buildResultView({
    conclusion: parts.conclusion,
    processItems: parts.processItems,
    outputs: parts.outputs,
    errors: parts.errors
  }, turn.status), [parts.conclusion, parts.processItems, parts.outputs, parts.errors, turn.status]);
  const hasVisibleWork = Boolean(result.hasContent || hasProcess);
  const status = elapsedText(turn, active, hasVisibleWork, now);
  const isRunning = turn.status === "running";

  return (
    <div className="pi-session-turn">
      <UserMessage item={parts.user}/>

      {hasProcess && (
        <ProcessSection
          processItems={parts.processItems}
          turnStatus={turn.status}
          expanded={expanded}
          expandedCommands={expandedCommands}
          onToggleTurn={onToggleTurn}
          onToggleCommand={onToggleCommand}
        />
      )}

      {parts.subagents.length > 0 && <SubagentInlineNotice groups={parts.subagents}/>}

      {!hasProcess && isRunning && <div className="pi-session-thinking">正在思考…</div>}

      {/* Elapsed time */}
      <div className="pi-session-elapsed">{status}</div>

      <ResultSection result={result} onOpenFile={onOpenFile} onOpenDirectory={onOpenDirectory}/>

      {!result.conclusion && isRunning && hasProcess && (
        <div className="pi-session-thinking">正在输出结果…</div>
      )}

      {!hasProcess && parts.errors.map((e) => (
        <div className="pi-session-error-block" key={e.id}>
          <div className="pi-session-error-title">{e.title}</div>
          <pre className="pi-session-code"><code>{e.detail}</code></pre>
        </div>
      ))}

    </div>
  );
}

// ─── Main Component ──────────────────────────────────────────────────

export default function SessionTimeline({ project, session, runtimeStatus, onOpenFile, onOpenDirectory }) {
  const viewportRef = useRef(null);
  const shouldAutoScrollRef = useRef(true);
  const [expandedTurns, setExpandedTurns] = useState(() => new Set());
  const [expandedCommands, setExpandedCommands] = useState(() => new Set());
  const [now, setNow] = useState(Date.now());
  const turns = useMemo(() => buildSessionTimeline(session), [session]);
  const active = Boolean(runtimeStatus?.processing || runtimeStatus?.starting);
  const turnOutputFileKeys = useMemo(() => collectTurnOutputFileKeys(turns), [turns]);
  const fallbackOutputFiles = useMemo(() => uniqueFiles(session?.output_files || []).filter((f) => !turnOutputFileKeys.has(fileKey(f))), [session?.output_files, turnOutputFileKeys]);
  const fallbackOutputTurnId = useMemo(() => latestCompletedTurnId(turns), [turns]);
  const modelLabel = formatModel(runtimeStatus?.model || session?.current_model);

  useEffect(() => { if (!active) return; const t = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(t); }, [active]);
  useEffect(() => { shouldAutoScrollRef.current = true; window.requestAnimationFrame(() => { if (viewportRef.current) viewportRef.current.scrollTop = viewportRef.current.scrollHeight; }); }, [session?.id]);
  useEffect(() => { if (!active || !viewportRef.current || !shouldAutoScrollRef.current) return; viewportRef.current.scrollTop = viewportRef.current.scrollHeight; }, [active, session?.output, session?.updated_at, turns.length]);
  function handleViewportScroll(e) { shouldAutoScrollRef.current = isNearScrollBottom(e.currentTarget); }

  function toggleTurn(id) { setExpandedTurns((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; }); }
  function toggleCommand(id) { setExpandedCommands((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; }); }

  if (!session) {
    return (
      <div className="session-view pi-session-view">
        <div className="session-empty-state"><Clock3 size={20}/><strong>未选择会话</strong><span>请先在左侧选择或创建一个 Pi 会话。</span></div>
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
          <div className="session-empty-state"><Bot size={20}/><strong>会话尚未开始</strong><span>在下方输入任务后，这里会按结构化风格整理展示。</span></div>
        ) : (
          turns.map((turn, idx) => (
            <TurnView
              key={turn.id}
              turn={turn}
              runtimeStatus={idx === turns.length - 1 ? runtimeStatus : null}
              fallbackOutputFiles={turn.id === fallbackOutputTurnId ? fallbackOutputFiles : []}
              expanded={expandedTurns.has(turn.id)}
              expandedCommands={expandedCommands}
              onToggleTurn={() => toggleTurn(turn.id)}
              onToggleCommand={toggleCommand}
              onOpenFile={onOpenFile}
              onOpenDirectory={onOpenDirectory}
              now={now}
            />
          ))
        )}
      </div>
    </div>
  );
}
