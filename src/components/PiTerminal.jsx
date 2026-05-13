import React, { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";

const TERMINAL_SCROLLBACK_STORAGE_KEY = "piIdeTerminalScrollback";
const DEFAULT_TERMINAL_SCROLLBACK = 100000;

function configuredPositiveNumber(key, fallback) {
  const value = Number(localStorage.getItem(key));
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function terminalScrollbackLimit() {
  return configuredPositiveNumber(TERMINAL_SCROLLBACK_STORAGE_KEY, DEFAULT_TERMINAL_SCROLLBACK);
}

function debugLog(enabled, workdir, message, data = undefined) {
  if (!enabled) return;
  const suffix = data === undefined ? "" : ` ${JSON.stringify(data)}`;
  invoke("append_debug_log", { source: "terminal", message: `${message}${suffix}`, workdir: workdir || null }).catch(() => {});
}

function normalizeForScrollableTerminal(data) {
  // 终端视图必须保持真实 PTY 字节流语义。
  // 之前为了把 TUI 输出强行变成“可滚动文本”，过滤了 alt-screen / clear-screen
  // 等控制序列，导致 Pi/Codex 类 TUI 的重绘帧被追加到 scrollback，出现回复文本错乱、
  // 重复和滚动长度异常。这里不再改写 ANSI 控制序列，交给 xterm 正确解释。
  return String(data || "");
}

export default function PiTerminal({ activeSessionId, clearSignal, replaySignal = 0, replayContent = "", debugEnabled = false, debugWorkdir = "", onTerminalInput }) {
  const hostRef = useRef(null);
  const terminalRef = useRef(null);
  const fitRef = useRef(null);
  const pendingRef = useRef("");
  const writingRef = useRef(false);
  const resizeFrameRef = useRef(null);
  const replayTimeoutRef = useRef(null);
  const isReplayingRef = useRef(false);
  const activeSessionIdRef = useRef(activeSessionId);
  const onTerminalInputRef = useRef(onTerminalInput);
  const debugEnabledRef = useRef(debugEnabled);
  const debugWorkdirRef = useRef(debugWorkdir);
  const logDebug = (message, data) => debugLog(debugEnabledRef.current, debugWorkdirRef.current, message, data);

  useEffect(() => {
    debugEnabledRef.current = debugEnabled;
    debugWorkdirRef.current = debugWorkdir;
  }, [debugEnabled, debugWorkdir]);

  useEffect(() => {
    logDebug("activeSession changed", { from: activeSessionIdRef.current, to: activeSessionId });
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

  useEffect(() => {
    onTerminalInputRef.current = onTerminalInput;
  }, [onTerminalInput]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    logDebug("PiTerminal mount", { activeSessionId: activeSessionIdRef.current });
    const term = new Terminal({
      cursorBlink: true,
      convertEol: false,
      disableStdin: false,
      scrollback: terminalScrollbackLimit(),
      scrollOnUserInput: false,
      smoothScrollDuration: 0,
      fontFamily: "Menlo, Monaco, Consolas, 'Courier New', monospace",
      fontSize: 13,
      theme: { background: "#111111", foreground: "#e8e8e8", cursor: "#e8e8e8", selectionBackground: "#343434" }
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);

    terminalRef.current = term;
    fitRef.current = fit;

    const flush = () => {
      if (writingRef.current || !pendingRef.current) return;
      const chunk = pendingRef.current;
      pendingRef.current = "";
      writingRef.current = true;
      term.write(chunk, () => {
        writingRef.current = false;
        flush();
      });
    };

    const writeTerminal = (data) => {
      pendingRef.current += normalizeForScrollableTerminal(data);
      flush();
    };

    const fitAndNotify = () => {
      if (resizeFrameRef.current) cancelAnimationFrame(resizeFrameRef.current);
      resizeFrameRef.current = requestAnimationFrame(() => {
        resizeFrameRef.current = null;
        try {
          fit.fit();
          const sessionId = activeSessionIdRef.current;
          if (sessionId) invoke("resize_pi", { sessionId, cols: term.cols, rows: term.rows }).catch(() => {});
        } catch (_) {
          // 布局尚未稳定时忽略，下一次 ResizeObserver 会重试。
        }
      });
    };

    fitAndNotify();

    const onHostPointerDown = () => {
      term.focus();
    };

    const dataDisposable = term.onData((data) => {
      if (isReplayingRef.current) {
        logDebug("terminal onData ignored during replay", { activeSessionId: activeSessionIdRef.current, bytes: data.length });
        return;
      }
      const sessionId = activeSessionIdRef.current;
      if (!sessionId) return;
      if (onTerminalInputRef.current) onTerminalInputRef.current(data).catch(() => {});
      else invoke("send_pi_input", { sessionId, input: data }).catch(() => {});
    });
    const resizeObserver = new ResizeObserver(fitAndNotify);
    resizeObserver.observe(host);
    host.addEventListener("pointerdown", onHostPointerDown);
    window.addEventListener("resize", fitAndNotify);

    let unsubscribeOutput = null;
    listen("pi-output", (event) => {
      const payload = event.payload || {};
      const sessionId = payload.sessionId || payload.session_id;
      const data = String(payload.data ?? "");
      logDebug("terminal pi-output", { sessionId, active: activeSessionIdRef.current, bytes: data.length, accepted: Boolean(sessionId && sessionId === activeSessionIdRef.current) });
      if (!sessionId || sessionId !== activeSessionIdRef.current) return;
      writeTerminal(data);
    }).then((unsubscribe) => {
      unsubscribeOutput = unsubscribe;
    });

    return () => {
      if (resizeFrameRef.current) cancelAnimationFrame(resizeFrameRef.current);
      if (replayTimeoutRef.current) clearTimeout(replayTimeoutRef.current);
      resizeObserver.disconnect();
      host.removeEventListener("pointerdown", onHostPointerDown);
      dataDisposable.dispose();
      window.removeEventListener("resize", fitAndNotify);
      logDebug("PiTerminal unmount", { activeSessionId: activeSessionIdRef.current });
      unsubscribeOutput?.();
      term.dispose();
      terminalRef.current = null;
      fitRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (clearSignal === 0) return;
    const term = terminalRef.current;
    if (!term) return;
    pendingRef.current = "";
    writingRef.current = false;
    term.clear();
  }, [clearSignal]);

  useEffect(() => {
    if (replaySignal === 0) return;
    const term = terminalRef.current;
    if (!term) return;
    pendingRef.current = "";
    writingRef.current = false;
    logDebug("terminal replay", { activeSessionId: activeSessionIdRef.current, replaySignal, bytes: String(replayContent || "").length });
    isReplayingRef.current = true;
    term.options.disableStdin = true;
    let finished = false;
    const finishReplay = (reason = "callback") => {
      if (finished) return;
      finished = true;
      if (replayTimeoutRef.current) clearTimeout(replayTimeoutRef.current);
      replayTimeoutRef.current = null;
      isReplayingRef.current = false;
      term.options.disableStdin = false;
      logDebug("terminal replay end", { activeSessionId: activeSessionIdRef.current, replaySignal, reason });
    };
    term.reset();
    const content = normalizeForScrollableTerminal(replayContent);
    if (!content) {
      finishReplay("empty");
      return;
    }
    term.write(content, () => finishReplay("callback"));
  }, [replaySignal, replayContent]);

  return (
    <div className="xterm-frame terminal-native">
      <div className="xterm-host" ref={hostRef} />
    </div>
  );
}
