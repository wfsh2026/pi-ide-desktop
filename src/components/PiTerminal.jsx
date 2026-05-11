import React, { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";

export default function PiTerminal({ clearSignal, onOutput }) {
  const hostRef = useRef(null);
  const terminalRef = useRef(null);
  const fitRef = useRef(null);
  const pendingRef = useRef("");
  const writingRef = useRef(false);
  const resizeFrameRef = useRef(null);
  const onOutputRef = useRef(onOutput);

  useEffect(() => {
    onOutputRef.current = onOutput;
  }, [onOutput]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      cursorBlink: true,
      convertEol: true,
      scrollback: 5000,
      fontFamily: "Menlo, Monaco, Consolas, 'Courier New', monospace",
      fontSize: 13,
      theme: { background: "#0b1020", foreground: "#e6edf3" }
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
      pendingRef.current += data;
      flush();
    };

    const fitAndNotify = () => {
      if (resizeFrameRef.current) cancelAnimationFrame(resizeFrameRef.current);
      resizeFrameRef.current = requestAnimationFrame(() => {
        resizeFrameRef.current = null;
        try {
          fit.fit();
          invoke("resize_pi", { cols: term.cols, rows: term.rows }).catch(() => {});
        } catch (_) {
          // 容器尺寸为 0 或 WebView 正在布局时可能抛错，下一次 ResizeObserver 会重试。
        }
      });
    };

    fitAndNotify();
    term.writeln("Pi IDE Desktop ready. 点击左侧启动 Pi，然后在下方增强输入框发送指令。\r\n");

    const resizeObserver = new ResizeObserver(fitAndNotify);
    resizeObserver.observe(host);
    window.addEventListener("resize", fitAndNotify);

    let unsubscribeOutput = null;
    listen("pi-output", (event) => {
      const data = String(event.payload ?? "");
      onOutputRef.current?.(data);
      writeTerminal(data);
    }).then((unsubscribe) => {
      unsubscribeOutput = unsubscribe;
    });

    return () => {
      if (resizeFrameRef.current) cancelAnimationFrame(resizeFrameRef.current);
      resizeObserver.disconnect();
      window.removeEventListener("resize", fitAndNotify);
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

  return <div className="xterm-host" ref={hostRef} />;
}
