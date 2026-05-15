import React from "react";
import { createRoot } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import AppErrorBoundary from "./components/AppErrorBoundary.jsx";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";

function safeLogData(data) {
  try {
    return JSON.stringify(data, (_key, value) => {
      if (typeof value === "string" && value.length > 800) return `${value.slice(0, 800)}…`;
      return value;
    });
  } catch (error) {
    return JSON.stringify({ serializationError: String(error) });
  }
}

function errorData(error, extra = {}) {
  return {
    name: error?.name || "",
    message: error?.message || String(error || ""),
    stack: error?.stack || "",
    ...extra
  };
}

function bootLog(message, data = undefined, force = false) {
  const suffix = data === undefined ? "" : ` ${safeLogData(data)}`;
  invoke("append_debug_log", {
    source: "frontend-boot",
    message: `${message}${suffix}`,
    workdir: null,
    force
  }).catch(() => {});
}

window.addEventListener("error", (event) => {
  bootLog("window error", {
    message: event.message,
    filename: event.filename,
    lineno: event.lineno,
    colno: event.colno,
    error: errorData(event.error)
  }, true);
});

window.addEventListener("unhandledrejection", (event) => {
  bootLog("unhandled rejection", errorData(event.reason), true);
});

async function bootstrap() {
  bootLog("bootstrap start");
  const rootElement = document.getElementById("root");
  if (!rootElement) {
    bootLog("root element missing", undefined, true);
    return;
  }

  const { default: App } = await import("./App.jsx");
  createRoot(rootElement).render(
    <React.StrictMode>
      <AppErrorBoundary onError={(error, info) => bootLog("react render error", errorData(error, info), true)}>
        <App />
      </AppErrorBoundary>
    </React.StrictMode>
  );
  bootLog("root render scheduled");
}

bootstrap().catch((error) => {
  bootLog("bootstrap failed", errorData(error), true);
  const rootElement = document.getElementById("root");
  if (rootElement) {
    rootElement.innerHTML = "<div class=\"app-error-screen\"><div><strong>界面启动失败，已写入调试日志。</strong></div></div>";
  }
});
