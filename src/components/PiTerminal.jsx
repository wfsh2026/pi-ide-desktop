import React, { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";

function normalizeForScrollableTerminal(data) {
  return String(data || "")
    .replace(/\x1b\[\?(?:1000|1002|1003|1005|1006|1015|1007|2004)[hl]/g, "")
    .replace(/\x1b\[\?(?:1047|1048|1049)[hl]/g, "")
    .replace(/\x1b\[3J/g, "");
}

export default function PiTerminal({ clearSignal, replaySignal = 0, replayContent = "", onOutput, terminalInputEnabled = true }) {
  const hostRef = useRef(null);
  const scrollbarRef = useRef(null);
  const thumbRef = useRef(null);
  const terminalRef = useRef(null);
  const fitRef = useRef(null);
  const pendingRef = useRef("");
  const writingRef = useRef(false);
  const resizeFrameRef = useRef(null);
  const onOutputRef = useRef(onOutput);
  const terminalInputEnabledRef = useRef(terminalInputEnabled);

  useEffect(() => {
    onOutputRef.current = onOutput;
  }, [onOutput]);

  useEffect(() => {
    terminalInputEnabledRef.current = terminalInputEnabled;
    const term = terminalRef.current;
    if (term) {
      term.options.disableStdin = !terminalInputEnabled;
      if (terminalInputEnabled) term.focus();
    }
  }, [terminalInputEnabled]);

  useEffect(() => {
    const host = hostRef.current;
    const scrollbar = scrollbarRef.current;
    const thumb = thumbRef.current;
    if (!host || !scrollbar || !thumb) return;

    const term = new Terminal({
      cursorBlink: true,
      convertEol: false,
      disableStdin: !terminalInputEnabledRef.current,
      scrollback: 100000,
      scrollOnUserInput: false,
      smoothScrollDuration: 0,
      fontFamily: "Menlo, Monaco, Consolas, 'Courier New', monospace",
      fontSize: 13,
      theme: { background: "#0b1020", foreground: "#e6edf3" }
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);

    terminalRef.current = term;
    fitRef.current = fit;

    const getMaxScroll = () => Math.max(0, term.buffer.active.baseY || 0);

    const updateCustomScrollbar = () => {
      const maxScroll = getMaxScroll();
      const trackHeight = scrollbar.clientHeight || 1;
      if (maxScroll <= 0) {
        thumb.style.height = `${trackHeight}px`;
        thumb.style.transform = "translateY(0px)";
        thumb.style.opacity = "0.35";
        return;
      }

      const totalRows = maxScroll + term.rows;
      const thumbHeight = Math.max(28, Math.floor(trackHeight * (term.rows / Math.max(1, totalRows))));
      const maxTop = Math.max(0, trackHeight - thumbHeight);
      const top = Math.round(maxTop * (term.buffer.active.viewportY / maxScroll));
      thumb.style.height = `${thumbHeight}px`;
      thumb.style.transform = `translateY(${top}px)`;
      thumb.style.opacity = "1";
    };

    const flush = () => {
      if (writingRef.current || !pendingRef.current) return;
      const chunk = pendingRef.current;
      pendingRef.current = "";
      writingRef.current = true;
      term.write(chunk, () => {
        writingRef.current = false;
        updateCustomScrollbar();
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
          // 右侧为自定义滚动条和边距预留约 4 列，真正缩小终端列数。
          const safeCols = Math.max(1, term.cols - 4);
          if (safeCols !== term.cols) term.resize(safeCols, term.rows);
          invoke("resize_pi", { cols: term.cols, rows: term.rows }).catch(() => {});
          updateCustomScrollbar();
        } catch (_) {
          // 布局尚未稳定时忽略，下一次 ResizeObserver 会重试。
        }
      });
    };

    fitAndNotify();

    const onWheel = (event) => {
      const lines = Math.sign(event.deltaY) * Math.max(1, Math.ceil(Math.abs(event.deltaY) / 40));
      term.scrollLines(lines);
      updateCustomScrollbar();
      event.preventDefault();
      event.stopPropagation();
    };

    const onTrackPointerDown = (event) => {
      event.preventDefault();
      event.stopPropagation();
      const maxScroll = getMaxScroll();
      if (maxScroll <= 0) return;

      const rect = scrollbar.getBoundingClientRect();
      const thumbRect = thumb.getBoundingClientRect();
      const trackHeight = rect.height;
      const thumbHeight = thumbRect.height;
      const maxTop = Math.max(1, trackHeight - thumbHeight);
      const startY = event.clientY;
      const currentTop = thumbRect.top - rect.top;
      const clickedThumb = event.target === thumb;
      const startTop = clickedThumb
        ? currentTop
        : Math.max(0, Math.min(maxTop, event.clientY - rect.top - thumbHeight / 2));

      if (!clickedThumb) {
        term.scrollToLine(Math.round((startTop / maxTop) * maxScroll));
        updateCustomScrollbar();
      }

      const onMove = (moveEvent) => {
        const nextTop = Math.max(0, Math.min(maxTop, startTop + (moveEvent.clientY - startY)));
        term.scrollToLine(Math.round((nextTop / maxTop) * maxScroll));
        updateCustomScrollbar();
        moveEvent.preventDefault();
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove, true);
        window.removeEventListener("pointerup", onUp, true);
      };
      window.addEventListener("pointermove", onMove, true);
      window.addEventListener("pointerup", onUp, true);
    };

    const onHostPointerDown = () => {
      if (terminalInputEnabledRef.current) term.focus();
    };

    const dataDisposable = term.onData((data) => {
      if (!terminalInputEnabledRef.current) return;
      invoke("send_pi_input", { input: data }).catch(() => {});
    });
    const resizeObserver = new ResizeObserver(fitAndNotify);
    resizeObserver.observe(host);
    host.addEventListener("wheel", onWheel, { passive: false, capture: true });
    host.addEventListener("pointerdown", onHostPointerDown);
    scrollbar.addEventListener("pointerdown", onTrackPointerDown, true);
    const scrollDisposable = term.onScroll(updateCustomScrollbar);
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
      host.removeEventListener("wheel", onWheel, { capture: true });
      host.removeEventListener("pointerdown", onHostPointerDown);
      scrollbar.removeEventListener("pointerdown", onTrackPointerDown, true);
      dataDisposable.dispose();
      scrollDisposable.dispose();
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

  useEffect(() => {
    if (replaySignal === 0) return;
    const term = terminalRef.current;
    if (!term) return;
    pendingRef.current = "";
    writingRef.current = false;
    term.reset();
    const content = normalizeForScrollableTerminal(replayContent);
    if (content) term.write(content);
  }, [replaySignal, replayContent]);

  return (
    <div className={`xterm-frame ${terminalInputEnabled ? "terminal-native" : "terminal-enhanced"}`}>
      <div className="xterm-host" ref={hostRef} />
      <div className="terminal-scrollbar" ref={scrollbarRef}>
        <div className="terminal-scrollbar-thumb" ref={thumbRef} />
      </div>
    </div>
  );
}
