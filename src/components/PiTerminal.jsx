import React, { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { hasTauriEventRuntime, hasTauriInvokeRuntime, trackAsyncUnsubscribe } from "../tauriRuntime.js";

const TERMINAL_SCROLLBACK_STORAGE_KEY = "piIdeTerminalScrollback";
const DEFAULT_TERMINAL_SCROLLBACK = 100000;

function configuredPositiveNumber(key, fallback) {
  const value = Number(localStorage.getItem(key));
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function terminalScrollbackLimit() {
  return configuredPositiveNumber(TERMINAL_SCROLLBACK_STORAGE_KEY, DEFAULT_TERMINAL_SCROLLBACK);
}

export default function PiTerminal({ activeSessionId, clearSignal, replaySignal = 0, replayContent = "", onTerminalInput }) {
  const hostRef = useRef(null);
  const terminalRef = useRef(null);
  const fitRef = useRef(null);
  const pendingRef = useRef("");
  const writingRef = useRef(false);
  const resizeFrameRef = useRef(null);
  const isReplayingRef = useRef(false);
  const activeSessionIdRef = useRef(activeSessionId);
  const onTerminalInputRef = useRef(onTerminalInput);

  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

  useEffect(() => {
    onTerminalInputRef.current = onTerminalInput;
  }, [onTerminalInput]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

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
      pendingRef.current += String(data || "");
      flush();
    };

    const fitAndNotify = () => {
      if (resizeFrameRef.current) cancelAnimationFrame(resizeFrameRef.current);
      resizeFrameRef.current = requestAnimationFrame(() => {
        resizeFrameRef.current = null;
        try {
          fit.fit();
          const sessionId = activeSessionIdRef.current;
          if (sessionId && hasTauriInvokeRuntime()) invoke("resize_pi", { sessionId, cols: term.cols, rows: term.rows }).catch(() => {});
        } catch (_) {}
      });
    };

    fitAndNotify();

    const onHostPointerDown = () => {
      term.focus();
    };

    const dataDisposable = term.onData((data) => {
      if (isReplayingRef.current) return;
      const sessionId = activeSessionIdRef.current;
      if (!sessionId) return;
      if (onTerminalInputRef.current) onTerminalInputRef.current(data).catch(() => {});
      else if (hasTauriInvokeRuntime()) invoke("send_pi_input", { sessionId, input: data }).catch(() => {});
    });
    const resizeObserver = new ResizeObserver(fitAndNotify);
    resizeObserver.observe(host);
    host.addEventListener("pointerdown", onHostPointerDown);
    window.addEventListener("resize", fitAndNotify);

    const unsubs = [];
    const pendingUnsubs = [];
    if (hasTauriEventRuntime()) {
      pendingUnsubs.push(trackAsyncUnsubscribe(listen("pi-output", (event) => {
        const payload = event.payload || {};
        const sessionId = payload.sessionId || payload.session_id;
        const data = String(payload.data ?? "");
        if (!sessionId || sessionId !== activeSessionIdRef.current) return;
        writeTerminal(data);
      }), unsubs));
    }

    return () => {
      pendingUnsubs.forEach((dispose) => dispose());
      if (resizeFrameRef.current) cancelAnimationFrame(resizeFrameRef.current);
      resizeObserver.disconnect();
      host.removeEventListener("pointerdown", onHostPointerDown);
      dataDisposable.dispose();
      window.removeEventListener("resize", fitAndNotify);
      unsubs.forEach((unsubscribe) => unsubscribe());
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
    isReplayingRef.current = true;
    term.options.disableStdin = true;
    term.reset();
    const content = String(replayContent || "");
    if (content) {
      term.write(content, () => {
        isReplayingRef.current = false;
        term.options.disableStdin = false;
      });
    } else {
      isReplayingRef.current = false;
      term.options.disableStdin = false;
    }
  }, [replaySignal, replayContent]);

  return (
    <div className="xterm-frame terminal-native">
      <div className="xterm-host" ref={hostRef} />
    </div>
  );
}
