import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { writeText as writeClipboardText } from "@tauri-apps/plugin-clipboard-manager";
import { Play, Square, Send, FolderOpen, Trash2, History, GitBranch, Settings, Copy } from "lucide-react";
import PiTerminal from "./components/PiTerminal.jsx";
import HistoryPanel from "./components/HistoryPanel.jsx";
import SessionTree from "./components/SessionTree.jsx";

const DEFAULT_COMMAND = "pi";

function stripAnsi(text) {
  return text.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");
}

function insertAtCursor(text, insert) {
  const start = text.selectionStart ?? 0;
  const end = text.selectionEnd ?? 0;
  const value = text.value ?? "";
  return {
    nextValue: `${value.slice(0, start)}${insert}${value.slice(end)}`,
    nextCursor: start + insert.length
  };
}

export default function App() {
  const [status, setStatus] = useState("未启动");
  const [clearTerminalSignal, setClearTerminalSignal] = useState(0);
  const [isProcessing, setIsProcessing] = useState(false);
  const [terminalInputEnabled, setTerminalInputEnabled] = useState(false);
  const [command, setCommand] = useState("");
  const [historyItems, setHistoryItems] = useState([]);
  const [sessionNodes, setSessionNodes] = useState([]);
  const [activeNodeId, setActiveNodeId] = useState(null);
  const [piCommand, setPiCommand] = useState(localStorage.getItem("piCommand") || DEFAULT_COMMAND);
  const [workdir, setWorkdir] = useState(localStorage.getItem("workdir") || "");
  const [storagePaths, setStoragePaths] = useState(null);
  const inputRef = useRef(null);
  const historyCursor = useRef(null);
  const outputBufferRef = useRef("");
  const processingRef = useRef(false);
  const outputIdleTimerRef = useRef(null);

  const loadLocalData = useCallback(async () => {
    setHistoryItems(await invoke("load_history"));
    const sessions = await invoke("load_sessions");
    setSessionNodes(sessions);
    setStoragePaths(await invoke("get_storage_paths"));
    if (!activeNodeId && sessions.length > 0) setActiveNodeId(sessions[sessions.length - 1].id);
  }, [activeNodeId]);

  useEffect(() => {
    loadLocalData().catch((e) => setStatus(String(e)));
    const unsubs = [];
    listen("pi-status", (event) => setStatus(String(event.payload))).then((f) => unsubs.push(f));
    listen("pi-output", (event) => {
      if (!processingRef.current) return;
      const payload = String(event.payload ?? "");
      if (outputIdleTimerRef.current) clearTimeout(outputIdleTimerRef.current);
      if (payload.includes("[PTY 读取错误]") || payload.includes("Pi 已停止")) {
        processingRef.current = false;
        setIsProcessing(false);
        return;
      }
      outputIdleTimerRef.current = setTimeout(() => {
        processingRef.current = false;
        setIsProcessing(false);
      }, 2000);
    }).then((f) => unsubs.push(f));
    return () => {
      if (outputIdleTimerRef.current) clearTimeout(outputIdleTimerRef.current);
      unsubs.forEach((f) => f());
    };
  }, []);

  const activeNode = useMemo(() => sessionNodes.find((n) => n.id === activeNodeId), [sessionNodes, activeNodeId]);

  async function startPi() {
    localStorage.setItem("piCommand", piCommand);
    localStorage.setItem("workdir", workdir);
    await invoke("start_pi", { piCommand, workdir });
  }

  async function stopPi() {
    await invoke("stop_pi");
    if (outputIdleTimerRef.current) clearTimeout(outputIdleTimerRef.current);
    processingRef.current = false;
    setIsProcessing(false);
  }

  function rememberOutput(data) {
    outputBufferRef.current += data;
  }

  function clearTerminal() {
    outputBufferRef.current = "";
    setClearTerminalSignal((value) => value + 1);
  }

  async function copyOutput() {
    const output = outputBufferRef.current;
    if (!output) {
      setStatus("当前没有可复制的输出");
      return;
    }
    await writeClipboardText(output);
    setStatus("终端输出已复制到剪贴板");
  }

  async function stopCurrentRun() {
    await invoke("send_pi_input", { input: "\x03" });
    if (outputIdleTimerRef.current) clearTimeout(outputIdleTimerRef.current);
    processingRef.current = false;
    setIsProcessing(false);
  }

  async function sendCommand(raw = command) {
    const trimmed = raw.trim();
    if (!trimmed) return;
    processingRef.current = true;
    setIsProcessing(true);
    try {
      await invoke("send_pi_input", { input: `${trimmed}\r` });
    } catch (error) {
      processingRef.current = false;
      setIsProcessing(false);
      throw error;
    }
    const newHistory = await invoke("append_history", { command: trimmed });
    setHistoryItems(newHistory);
    const title = trimmed.length > 48 ? `${trimmed.slice(0, 48)}…` : trimmed;
    const newSessions = await invoke("append_session_node", {
      parentId: activeNodeId,
      title,
      command: trimmed
    });
    setSessionNodes(newSessions);
    setActiveNodeId(newSessions[newSessions.length - 1]?.id ?? null);
    setCommand("");
    historyCursor.current = null;
  }

  async function chooseWorkdir() {
    const selected = await open({ directory: true, multiple: false, title: "选择 Pi 工作目录" });
    if (typeof selected === "string") setWorkdir(selected);
  }

  async function chooseFiles() {
    const selected = await open({ multiple: true, title: "选择要插入的文件" });
    if (!selected) return;
    const files = Array.isArray(selected) ? selected : [selected];
    insertText(files.map((f) => `"${f}"`).join(" "));
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
    const files = Array.from(e.dataTransfer.files || []);
    const paths = files.map((f) => f.path || f.name).filter(Boolean);
    if (paths.length) insertText(paths.map((p) => `"${p}"`).join(" "));
  }

  function handleComposerAction() {
    if (isProcessing) {
      stopCurrentRun().catch((err) => setStatus(String(err)));
    } else {
      sendCommand().catch((err) => setStatus(String(err)));
    }
  }

  function handleKeyDown(e) {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      handleComposerAction();
    }
    if (e.key === "ArrowUp" && command.trim() === "" && historyItems.length > 0) {
      e.preventDefault();
      historyCursor.current = historyItems.length - 1;
      setCommand(historyItems[historyCursor.current].command);
    } else if (e.key === "ArrowUp" && historyCursor.current !== null) {
      e.preventDefault();
      historyCursor.current = Math.max(0, historyCursor.current - 1);
      setCommand(historyItems[historyCursor.current].command);
    } else if (e.key === "ArrowDown" && historyCursor.current !== null) {
      e.preventDefault();
      historyCursor.current = Math.min(historyItems.length - 1, historyCursor.current + 1);
      setCommand(historyItems[historyCursor.current].command);
    }
  }

  async function deleteSessionNode(id) {
    if (!window.confirm("确定删除该会话及其所有子会话吗？")) return;
    const nextNodes = await invoke("delete_session_node", { id });
    setSessionNodes(nextNodes);
    if (!nextNodes.some((node) => node.id === activeNodeId)) {
      setActiveNodeId(nextNodes[nextNodes.length - 1]?.id ?? null);
    }
  }

  async function clearAll() {
    await invoke("clear_history");
    await invoke("clear_sessions");
    await loadLocalData();
    setActiveNodeId(null);
  }

  return (
    <div className="app" onDragOver={(e) => e.preventDefault()} onDrop={handleDrop}>
      <aside className="sidebar left">
        <div className="brand">Pi IDE</div>
        <section className="panel">
          <h3><Settings size={16}/> 运行设置</h3>
          <label>Pi 命令</label>
          <input value={piCommand} onChange={(e) => setPiCommand(e.target.value)} placeholder="pi 或完整路径" />
          <label>工作目录</label>
          <div className="row">
            <input value={workdir} onChange={(e) => setWorkdir(e.target.value)} placeholder="可留空" />
            <button title="选择目录" onClick={chooseWorkdir}><FolderOpen size={16}/></button>
          </div>
          <div className="row buttons">
            <button className="primary" onClick={() => startPi().catch((e) => setStatus(String(e)))}><Play size={16}/> 启动</button>
            <button onClick={() => stopPi().catch((e) => setStatus(String(e)))}><Square size={16}/> 停止</button>
          </div>
        </section>
        <section className="panel small">
          <h3>本地存储</h3>
          <p>{storagePaths?.dir || "~/.pi-ide"}</p>
          <button onClick={() => writeClipboardText(storagePaths?.dir || "").catch((e) => setStatus(`复制失败：${e}`))}><Copy size={14}/> 复制路径</button>
        </section>
      </aside>

      <main className="main">
        <header className="topbar">
          <span className="status">{status}</span>
          <button onClick={clearTerminal}>清空输出</button>
          <button onClick={() => copyOutput().catch((e) => setStatus(`复制失败：${e}`))}><Copy size={15}/> 复制输出</button>
          <button className={terminalInputEnabled ? "primary" : ""} onClick={() => setTerminalInputEnabled((value) => !value)}>
            {terminalInputEnabled ? "原生终端：开" : "原生终端：关"}
          </button>
          <button onClick={() => sendCommand('/tree').catch((e) => setStatus(String(e)))}><GitBranch size={15}/> 发送 /tree</button>
          <button className="danger" onClick={() => clearAll().catch((e) => setStatus(String(e)))}><Trash2 size={15}/> 清空历史/会话</button>
        </header>
        <div className="terminal-wrap">
          <PiTerminal clearSignal={clearTerminalSignal} onOutput={rememberOutput} terminalInputEnabled={terminalInputEnabled} />
        </div>
        <div className="composer">
          <div className="composer-toolbar">
            <span>{terminalInputEnabled ? "原生终端模式：可直接点击上方终端输入，快捷键交给 Pi；下方仍可批量发送。" : "增强输入模式：支持多行、鼠标定位、Ctrl/⌘ + Enter 执行、拖拽文件插入路径"}</span>
            <button onClick={chooseFiles}><FolderOpen size={15}/> 插入文件</button>
          </div>
          <textarea
            ref={inputRef}
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={'输入 Pi 指令或自然语言任务。例如：帮我分析这个文件 "/path/to/file"'}
          />
          <div className="composer-actions">
            <span>当前父节点：{activeNode?.title || "根节点"}</span>
            <button className={isProcessing ? "danger" : "primary"} onClick={handleComposerAction}>{isProcessing ? <Square size={16}/> : <Send size={16}/>} {isProcessing ? "停止" : "发送"}</button>
          </div>
        </div>
      </main>

      <aside className="sidebar right">
        <section className="panel fill-half">
          <h3><History size={16}/> 命令历史</h3>
          <HistoryPanel items={historyItems} onPick={setCommand} />
        </section>
        <section className="panel fill-half">
          <h3><GitBranch size={16}/> 本地会话树</h3>
          <SessionTree nodes={sessionNodes} activeId={activeNodeId} onSelect={setActiveNodeId} onDelete={(id) => deleteSessionNode(id).catch((e) => setStatus(String(e)))} />
        </section>
      </aside>
    </div>
  );
}
