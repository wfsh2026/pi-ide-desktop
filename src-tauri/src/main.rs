#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use once_cell::sync::Lazy;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, env, fs, io::{Read, Seek, SeekFrom, Write}, path::{Path, PathBuf}, process::Command, sync::Mutex as StdMutex};
use tauri::Emitter;
use tokio::sync::Mutex;

struct PiRuntime {
  writer: Box<dyn Write + Send>,
  child: Box<dyn Child + Send + Sync>,
  master: Box<dyn MasterPty + Send>,
  debug_enabled: bool,
}

static PI_SESSIONS: Lazy<Mutex<HashMap<String, PiRuntime>>> = Lazy::new(|| Mutex::new(HashMap::new()));
static PI_EVENT_OFFSETS: Lazy<StdMutex<HashMap<String, u64>>> = Lazy::new(|| StdMutex::new(HashMap::new()));

#[derive(Debug, Serialize, Deserialize, Clone)]
struct HistoryItem {
  command: String,
  created_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct SessionNode {
  id: String,
  parent_id: Option<String>,
  title: String,
  command: String,
  created_at: String,
}

#[derive(Debug, Serialize)]
struct LaunchContext {
  opened_from_context: bool,
  project_path: Option<String>,
}

#[derive(Debug, Serialize)]
struct DirectoryTreeNode {
  name: String,
  path: String,
  is_dir: bool,
  omitted: bool,
  children: Vec<DirectoryTreeNode>,
}

#[derive(Debug, Serialize)]
struct DirectoryTreeResponse {
  root: String,
  lines: Vec<String>,
  tree: DirectoryTreeNode,
  truncated: bool,
}

fn storage_dir() -> Result<PathBuf, String> {
  let home = dirs::home_dir().ok_or("无法定位用户 Home 目录")?;
  let dir = home.join(".pi-ide");
  fs::create_dir_all(&dir).map_err(|e| format!("创建存储目录失败: {e}"))?;
  Ok(dir)
}

fn history_path() -> Result<PathBuf, String> { Ok(storage_dir()?.join("history.json")) }
fn sessions_path() -> Result<PathBuf, String> { Ok(storage_dir()?.join("sessions.json")) }
fn debug_log_path() -> Result<PathBuf, String> { Ok(storage_dir()?.join("debug.log")) }
fn global_config_path() -> Result<PathBuf, String> { Ok(storage_dir()?.join("config.json")) }
fn project_config_path(workdir: &Path) -> PathBuf { workdir.join(".pi.ide").join("config.json") }

fn append_debug_line_raw(line: &str) {
  if let Ok(path) = debug_log_path() {
    if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(path) {
      let _ = writeln!(file, "{} {}", now_iso(), line);
    }
  }
}

fn append_debug_line_when(enabled: bool, line: &str) {
  if enabled {
    append_debug_line_raw(line);
  }
}

#[tauri::command]
fn append_debug_log(source: String, message: String, workdir: Option<String>) -> Result<(), String> {
  let workdir_path = workdir
    .as_deref()
    .map(str::trim)
    .filter(|s| !s.is_empty())
    .map(PathBuf::from);
  if resolve_debug_logging_enabled(workdir_path.as_deref(), None)? {
    append_debug_line_raw(&format!("[{source}] {message}"));
  }
  Ok(())
}

#[tauri::command]
fn get_debug_log_path() -> Result<String, String> {
  Ok(debug_log_path()?.to_string_lossy().to_string())
}

fn default_global_config(command: &str) -> serde_json::Value {
  serde_json::json!({
    "version": 1,
    "pi": {
      "command": command,
      "env": {}
    },
    "debug": {
      "enabled": false
    }
  })
}

fn default_project_config() -> serde_json::Value {
  serde_json::json!({
    "version": 1,
    "pi": {
      "command": "",
      "env": {}
    },
    "debug": {
      "enabled": false
    }
  })
}

fn read_json_value(path: &Path) -> Result<Option<serde_json::Value>, String> {
  if !path.exists() { return Ok(None); }
  let raw = fs::read_to_string(path).map_err(|e| format!("读取配置失败 {:?}: {e}", path))?;
  if raw.trim().is_empty() { return Ok(None); }
  let value = serde_json::from_str::<serde_json::Value>(&raw)
    .map_err(|e| format!("解析配置失败 {:?}: {e}", path))?;
  Ok(Some(value))
}

fn write_json_value(path: &Path, value: &serde_json::Value) -> Result<(), String> {
  if let Some(parent) = path.parent() {
    fs::create_dir_all(parent).map_err(|e| format!("创建配置目录失败 {:?}: {e}", parent))?;
  }
  let raw = serde_json::to_string_pretty(value).map_err(|e| format!("配置序列化失败: {e}"))?;
  fs::write(path, format!("{raw}\n")).map_err(|e| format!("写入配置失败 {:?}: {e}", path))
}

fn ensure_debug_config(value: &mut serde_json::Value) -> bool {
  let Some(map) = value.as_object_mut() else {
    return false;
  };
  let Some(debug) = map.get_mut("debug") else {
    map.insert("debug".to_string(), serde_json::json!({ "enabled": false }));
    return true;
  };
  let Some(debug_map) = debug.as_object_mut() else {
    *debug = serde_json::json!({ "enabled": false });
    return true;
  };
  if !matches!(debug_map.get("enabled"), Some(value) if value.is_boolean()) {
    debug_map.insert("enabled".to_string(), serde_json::Value::Bool(false));
    return true;
  }
  false
}

fn ensure_config_file_defaults(path: &Path, default_value: serde_json::Value) -> Result<(), String> {
  if !path.exists() {
    write_json_value(path, &default_value)?;
    return Ok(());
  }
  let Some(mut value) = read_json_value(path)? else {
    write_json_value(path, &default_value)?;
    return Ok(());
  };
  if ensure_debug_config(&mut value) {
    write_json_value(path, &value)?;
  }
  Ok(())
}

fn ensure_pi_ide_config_files(workdir: Option<&Path>, legacy_command: Option<&str>) -> Result<(PathBuf, Option<PathBuf>), String> {
  let global_path = global_config_path()?;
  let fallback_command = std::env::var("PI_IDE_PI_BIN").unwrap_or_else(|_| "pi".to_string());
  let command = legacy_command
    .map(str::trim)
    .filter(|s| !s.is_empty())
    .map(ToString::to_string)
    .unwrap_or(fallback_command);
  ensure_config_file_defaults(&global_path, default_global_config(&command))?;

  let project_path = if let Some(dir) = workdir.filter(|p| p.exists() && p.is_dir()) {
    let path = project_config_path(dir);
    ensure_config_file_defaults(&path, default_project_config())?;
    Some(path)
  } else {
    None
  };

  Ok((global_path, project_path))
}

fn config_command(value: Option<&serde_json::Value>) -> Option<String> {
  value
    .and_then(|v| v.get("pi"))
    .and_then(|pi| pi.get("command"))
    .and_then(|command| command.as_str())
    .map(str::trim)
    .filter(|command| !command.is_empty())
    .map(ToString::to_string)
}

fn config_env(value: Option<&serde_json::Value>) -> HashMap<String, String> {
  let mut envs = HashMap::new();
  if let Some(map) = value
    .and_then(|v| v.get("pi"))
    .and_then(|pi| pi.get("env"))
    .and_then(|env| env.as_object())
  {
    for (key, value) in map {
      if let Some(text) = value.as_str() {
        envs.insert(key.clone(), text.to_string());
      }
    }
  }
  envs
}

fn config_debug_enabled(value: Option<&serde_json::Value>) -> Option<bool> {
  value
    .and_then(|v| v.get("debug"))
    .and_then(|debug| debug.get("enabled"))
    .and_then(|enabled| enabled.as_bool())
}

fn resolve_debug_logging_enabled(workdir: Option<&Path>, legacy_command: Option<&str>) -> Result<bool, String> {
  let (global_path, project_path) = ensure_pi_ide_config_files(workdir, legacy_command)?;
  let global_config = read_json_value(&global_path)?;
  let project_config = match &project_path {
    Some(path) => read_json_value(path)?,
    None => None,
  };
  Ok(config_debug_enabled(project_config.as_ref())
    .or_else(|| config_debug_enabled(global_config.as_ref()))
    .unwrap_or(false))
}

#[tauri::command]
fn get_debug_logging_config(workdir: Option<String>) -> Result<serde_json::Value, String> {
  let workdir_path = workdir
    .as_deref()
    .map(str::trim)
    .filter(|s| !s.is_empty())
    .map(PathBuf::from);
  let (global_path, project_path) = ensure_pi_ide_config_files(workdir_path.as_deref(), None)?;
  let global_config = read_json_value(&global_path)?;
  let project_config = match &project_path {
    Some(path) => read_json_value(path)?,
    None => None,
  };
  let enabled = config_debug_enabled(project_config.as_ref())
    .or_else(|| config_debug_enabled(global_config.as_ref()))
    .unwrap_or(false);
  Ok(serde_json::json!({
    "enabled": enabled,
    "globalConfig": global_path.to_string_lossy(),
    "projectConfig": project_path.map(|path| path.to_string_lossy().to_string())
  }))
}

fn resolve_pi_launch_config(workdir: Option<&Path>, legacy_command: Option<&str>) -> Result<(String, HashMap<String, String>, serde_json::Value), String> {
  let (global_path, project_path) = ensure_pi_ide_config_files(workdir, legacy_command)?;
  let global_config = read_json_value(&global_path)?;
  let project_config = match &project_path {
    Some(path) => read_json_value(path)?,
    None => None,
  };

  let command = config_command(project_config.as_ref())
    .or_else(|| config_command(global_config.as_ref()))
    .or_else(|| legacy_command.map(str::trim).filter(|s| !s.is_empty()).map(ToString::to_string))
    .or_else(|| std::env::var("PI_IDE_PI_BIN").ok())
    .unwrap_or_else(|| "pi".to_string());

  let mut envs = config_env(global_config.as_ref());
  envs.extend(config_env(project_config.as_ref()));

  Ok((command, envs, serde_json::json!({
    "globalConfig": global_path.to_string_lossy(),
    "projectConfig": project_path.map(|path| path.to_string_lossy().to_string())
  })))
}

#[tauri::command]
fn ensure_pi_ide_config(workdir: Option<String>, legacy_command: Option<String>) -> Result<serde_json::Value, String> {
  let workdir_path = workdir
    .as_deref()
    .map(str::trim)
    .filter(|s| !s.is_empty())
    .map(PathBuf::from);
  let (global_path, project_path) = ensure_pi_ide_config_files(workdir_path.as_deref(), legacy_command.as_deref())?;
  let global_config = read_json_value(&global_path)?;
  let project_config = match &project_path {
    Some(path) => read_json_value(path)?,
    None => None,
  };
  let debug_enabled = config_debug_enabled(project_config.as_ref())
    .or_else(|| config_debug_enabled(global_config.as_ref()))
    .unwrap_or(false);
  Ok(serde_json::json!({
    "debugEnabled": debug_enabled,
    "globalConfig": global_path.to_string_lossy(),
    "projectConfig": project_path.map(|path| path.to_string_lossy().to_string())
  }))
}

const PI_IDE_BRIDGE_EXTENSION: &str = r#"import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

const bashBefore = new Map();
let sequence = 0;

function eventTextLimit() {
  const value = Number(process.env.PI_IDE_EVENT_TEXT_LIMIT || "50000");
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 50000;
}

function positiveEnvNumber(name, fallback) {
  const value = Number(process.env[name] || "");
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function envRegex(name, fallback, flags = "i") {
  try {
    return new RegExp(process.env[name] || fallback, flags);
  } catch {
    return new RegExp(fallback, flags);
  }
}

function limitText(value) {
  const text = String(value || "");
  const limit = eventTextLimit();
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n[Pi IDE truncated ${text.length - limit} chars]`;
}

function toolResultTextLimit() {
  return positiveEnvNumber("PI_IDE_TOOL_RESULT_TEXT_LIMIT", 50000);
}

function readLineLimit() {
  return positiveEnvNumber("PI_IDE_READ_LIMIT", 1200);
}

function dangerousCommandPattern() {
  return envRegex(
    "PI_IDE_DANGEROUS_COMMAND_PATTERN",
    String.raw`(?:\brm\s+-[^ \n\r;]*r[^ \n\r;]*f|\bgit\s+reset\s+--hard|\bgit\s+clean\s+-[^ \n\r;]*f|\bdel\s+/[sq]|\bformat\b|\bmkfs\b|\bRemove-Item\b[^\n\r;]*\b-Recurse\b)`
  );
}

function protectedPathPattern() {
  return envRegex(
    "PI_IDE_PROTECTED_PATH_PATTERN",
    String.raw`(^|[\\/])(?:\.env(?:\..*)?|\.git|node_modules)([\\/]|$)`
  );
}

function compactJson(value) {
  if (typeof value === "string") return limitText(value);
  if (Array.isArray(value)) return value.map(compactJson);
  if (value && typeof value === "object") {
    const next = {};
    for (const [key, item] of Object.entries(value)) {
      next[key] = compactJson(item);
    }
    return next;
  }
  return value;
}

function limitToolText(value) {
  const text = String(value || "");
  const limit = toolResultTextLimit();
  if (text.length <= limit) return { text, truncated: false };
  return {
    text: `${text.slice(0, limit)}\n[Pi IDE tool result truncated ${text.length - limit} chars]`,
    truncated: true,
  };
}

function compactToolContent(content) {
  let truncated = false;
  const next = (Array.isArray(content) ? content : []).map((item) => {
    if (typeof item === "string") {
      const limited = limitToolText(item);
      truncated ||= limited.truncated;
      return limited.text;
    }
    if (item?.type === "text") {
      const limited = limitToolText(item.text || "");
      truncated ||= limited.truncated;
      return { ...item, text: limited.text };
    }
    return item;
  });
  return { content: next, truncated };
}

function blockTool(ctx, event, reason) {
  appendEvent(ctx, {
    kind: "policy",
    source: "pi-ide-tool-policy",
    action: "blocked",
    toolCallId: event.toolCallId,
    toolName: event.toolName,
    reason,
  });
  return { block: true, reason };
}

function normalizeEventInput(event) {
  if (!event.input || typeof event.input !== "object") event.input = {};
  return event.input;
}

function applyToolPolicy(event, ctx) {
  const input = normalizeEventInput(event);

  if (event.toolName === "bash") {
    const command = String(input.command || input.cmd || "");
    if (dangerousCommandPattern().test(command)) {
      return blockTool(ctx, event, "Blocked dangerous shell command by Pi IDE policy");
    }
  }

  if (event.toolName === "write" || event.toolName === "edit") {
    const rawPath = String(input.path || "");
    const normalized = normalizeFilePath(ctx?.cwd || process.cwd(), rawPath);
    if (normalized && protectedPathPattern().test(normalized)) {
      return blockTool(ctx, event, `Blocked protected path by Pi IDE policy: ${path.basename(normalized)}`);
    }
  }

  if (event.toolName === "read") {
    const limit = readLineLimit();
    if (!input.limit || Number(input.limit) > limit) {
      input.limit = limit;
      appendEvent(ctx, {
        kind: "policy",
        source: "pi-ide-tool-policy",
        action: "patched",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        field: "limit",
        value: limit,
      });
    }
  }

  return undefined;
}

function eventFile(cwd) {
  return path.join(cwd, ".pi", "pi-ide-events.jsonl");
}

function normalizeFilePath(cwd, raw) {
  if (!raw) return "";
  const value = String(raw).trim();
  if (!value) return "";
  return path.normalize(path.isAbsolute(value) ? value : path.join(cwd, value));
}

function sessionInfo(ctx) {
  const manager = ctx?.sessionManager;
  return {
    sessionId: manager?.getSessionId?.(),
    sessionFile: manager?.getSessionFile?.(),
    leafId: manager?.getLeafId?.(),
    ideSessionId: process.env.PI_IDE_SESSION_ID,
    ideRunId: process.env.PI_IDE_RUN_ID,
  };
}

function appendEvent(ctx, payload) {
  const cwd = ctx?.cwd || process.cwd();
  const file = eventFile(cwd);
  sequence += 1;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify({
    schema: 1,
    id: payload.id || `${process.env.PI_IDE_RUN_ID || process.env.PI_IDE_SESSION_ID || "pi"}:${sequence}`,
    timestamp: new Date().toISOString(),
    cwd,
    ...sessionInfo(ctx),
    ...payload,
  }) + "\n", "utf8");
}

function textContent(message) {
  return (message?.content || []).map((item) => {
    if (typeof item === "string") return item;
    if (item?.type === "text") return item.text || "";
    return "";
  }).filter(Boolean).join("");
}

function compactResult(result) {
  return {
    content: compactJson(result?.content || []),
    details: compactJson(result?.details || {}),
  };
}

function modelInfo(model) {
  if (!model) return undefined;
  return {
    id: model.id || model.model || "",
    name: model.name || model.id || model.model || "",
    provider: model.provider || "",
    api: model.api || "",
  };
}

function modelList(ctx) {
  try {
    return (ctx?.modelRegistry?.getAvailable?.() || []).map(modelInfo).filter(Boolean);
  } catch (error) {
    appendEvent(ctx, {
      kind: "model_error",
      source: "model-list",
      error: String(error?.message || error),
    });
    return [];
  }
}

function emitModels(ctx, source = "unknown") {
  appendEvent(ctx, {
    kind: "models",
    source,
    models: modelList(ctx),
    currentModel: modelInfo(ctx?.model),
  });
}

function appendTimeline(ctx, eventType, payload = {}) {
  appendEvent(ctx, {
    kind: "timeline",
    eventType,
    ...payload,
  });
}

function recordPath(ctx, kind, source, toolCallId, toolName, rawPath, extra = {}) {
  const normalized = normalizeFilePath(ctx?.cwd || process.cwd(), rawPath);
  if (!normalized) return;
  appendEvent(ctx, {
    id: `${kind}:${source}:${toolCallId || "manual"}:${normalized}`,
    kind,
    source,
    toolCallId,
    toolName,
    path: normalized,
    name: path.basename(normalized),
    ...extra,
  });
}

function gitChangedFiles(cwd) {
  try {
    const output = execFileSync("git", ["status", "--porcelain", "-z"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return new Set(output.split("\0").filter(Boolean).map((entry) => normalizeFilePath(cwd, entry.slice(3))));
  } catch {
    return new Set();
  }
}

export default function(pi) {
  pi.registerCommand("pi-ide-list-models", {
    description: "Emit available models for Pi IDE Desktop",
    handler: async (_args, ctx) => {
      emitModels(ctx, "command");
    },
  });

  pi.registerCommand("pi-ide-switch-model", {
    description: "Switch model from Pi IDE Desktop. Args: JSON { provider, id }",
    handler: async (args, ctx) => {
      let payload;
      try {
        payload = JSON.parse(args || "{}");
      } catch (error) {
        appendEvent(ctx, { kind: "model_switch_result", success: false, error: `Invalid JSON: ${String(error?.message || error)}` });
        return;
      }

      const provider = String(payload.provider || "").trim();
      const modelId = String(payload.id || payload.model || "").trim();
      const model = provider && modelId ? ctx.modelRegistry.find(provider, modelId) : undefined;
      if (!model) {
        appendEvent(ctx, {
          kind: "model_switch_result",
          success: false,
          error: `Model not found: ${provider}/${modelId}`,
          requested: { provider, id: modelId },
        });
        ctx.ui.notify(`Model not found: ${provider}/${modelId}`, "error");
        return;
      }

      const ok = await pi.setModel(model);
      appendEvent(ctx, {
        kind: "model_switch_result",
        success: Boolean(ok),
        model: modelInfo(model),
        error: ok ? "" : "No API key or auth unavailable",
      });
      if (!ok) ctx.ui.notify(`Cannot switch model: ${provider}/${modelId}`, "error");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    appendEvent(ctx, { kind: "session", source: "session-start", model: modelInfo(ctx?.model) });
    appendEvent(ctx, { kind: "model", source: "session-start", model: modelInfo(ctx?.model) });
    emitModels(ctx, "session-start");
  });

  pi.on("model_select", async (event, ctx) => {
    appendEvent(ctx, {
      kind: "model",
      source: event.source,
      model: modelInfo(event.model),
      previousModel: modelInfo(event.previousModel),
    });
  });

  pi.on("agent_start", async (event, ctx) => {
    appendTimeline(ctx, event.type);
  });

  pi.on("agent_end", async (event, ctx) => {
    appendTimeline(ctx, event.type);
  });

  pi.on("turn_start", async (event, ctx) => {
    appendTimeline(ctx, event.type, {
      turnIndex: event.turnIndex,
      turnTimestamp: event.timestamp,
    });
  });

  pi.on("turn_end", async (event, ctx) => {
    appendTimeline(ctx, event.type, {
      turnIndex: event.turnIndex,
      text: limitText(textContent(event.message)),
      toolResults: event.toolResults?.map(compactResult) || [],
    });
  });

  pi.on("message_update", async (event, ctx) => {
    const delta = event.assistantMessageEvent || {};
    appendTimeline(ctx, event.type, {
      messageId: event.message?.id,
      deltaType: delta.type,
      contentIndex: delta.contentIndex,
      delta: limitText(delta.delta || ""),
      reason: limitText(delta.reason || ""),
    });
  });

  pi.on("message_end", async (event, ctx) => {
    appendTimeline(ctx, event.type, {
      messageId: event.message?.id,
      text: limitText(textContent(event.message)),
      messageRole: event.message?.role,
      model: modelInfo(event.message),
    });
  });

  pi.on("tool_execution_start", async (event, ctx) => {
    appendTimeline(ctx, event.type, {
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      args: compactJson(event.args || {}),
    });
  });

  pi.on("tool_execution_update", async (event, ctx) => {
    appendTimeline(ctx, event.type, {
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      args: compactJson(event.args || {}),
      partialResult: compactResult(event.partialResult),
    });
  });

  pi.on("tool_execution_end", async (event, ctx) => {
    appendTimeline(ctx, event.type, {
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      result: compactResult(event.result),
      isError: Boolean(event.isError),
    });
  });

  pi.on("tool_call", async (event, ctx) => {
    const policyResult = applyToolPolicy(event, ctx);
    if (policyResult) return policyResult;

    if (event.toolName === "bash") {
      bashBefore.set(event.toolCallId, gitChangedFiles(ctx.cwd));
    }
  });

  pi.on("tool_result", async (event, ctx) => {
    const compacted = compactToolContent(event.content);
    if (compacted.truncated) {
      appendEvent(ctx, {
        kind: "policy",
        source: "pi-ide-tool-policy",
        action: "truncated",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
      });
    }
    const resultPatch = compacted.truncated ? {
      content: compacted.content,
      details: {
        ...(event.details || {}),
        piIdeTruncated: true,
      },
    } : undefined;

    if (event.isError) return resultPatch;
    const input = event.input || {};
    const toolName = event.toolName;
    const toolCallId = event.toolCallId;

    if (toolName === "read") {
      recordPath(ctx, "reference", "pi-tool-read", toolCallId, toolName, input.path);
      return resultPatch;
    }

    if (toolName === "write") {
      recordPath(ctx, "output", "pi-tool-write", toolCallId, toolName, input.path);
      return resultPatch;
    }

    if (toolName === "edit") {
      recordPath(ctx, "output", "pi-tool-edit", toolCallId, toolName, input.path);
      return resultPatch;
    }

    if (toolName === "bash") {
      const before = bashBefore.get(toolCallId) || new Set();
      bashBefore.delete(toolCallId);
      const after = gitChangedFiles(ctx.cwd);
      for (const filePath of after) {
        if (!before.has(filePath)) {
          recordPath(ctx, "output", "pi-tool-bash-diff", toolCallId, toolName, filePath, { confidence: "detected" });
        }
      }
    }

    return resultPatch;
  });
}
"#;

fn pi_ide_file_events_path(workdir: &Path) -> PathBuf {
  workdir.join(".pi").join("pi-ide-file-events.jsonl")
}

fn pi_ide_events_path(workdir: &Path) -> PathBuf {
  workdir.join(".pi").join("pi-ide-events.jsonl")
}

fn ensure_pi_ide_file_tracker(workdir: &Path) -> Result<(), String> {
  let pi_dir = workdir.join(".pi");
  let extensions_dir = pi_dir.join("extensions");
  fs::create_dir_all(&extensions_dir).map_err(|e| format!("创建 Pi IDE 扩展目录失败: {e}"))?;
  fs::write(extensions_dir.join("pi-ide-file-tracker.ts"), PI_IDE_BRIDGE_EXTENSION)
    .map_err(|e| format!("写入 Pi IDE 事件桥扩展失败: {e}"))?;
  let events_path = pi_ide_events_path(workdir);
  if !events_path.exists() {
    fs::write(&events_path, "").map_err(|e| format!("初始化 Pi IDE 事件流失败: {e}"))?;
  }
  let legacy_events_path = pi_ide_file_events_path(workdir);
  if !legacy_events_path.exists() {
    fs::write(&legacy_events_path, "").map_err(|e| format!("初始化 Pi IDE 文件事件失败: {e}"))?;
  }
  Ok(())
}

fn now_iso() -> String { chrono::Utc::now().to_rfc3339() }

fn read_json_array<T: for<'de> Deserialize<'de>>(path: PathBuf) -> Result<Vec<T>, String> {
  if !path.exists() { return Ok(vec![]); }
  let raw = fs::read_to_string(&path).map_err(|e| format!("读取文件失败 {:?}: {e}", path))?;
  if raw.trim().is_empty() { return Ok(vec![]); }
  serde_json::from_str(&raw).map_err(|e| format!("JSON 解析失败 {:?}: {e}", path))
}

fn write_json_array<T: Serialize>(path: PathBuf, value: &Vec<T>) -> Result<(), String> {
  let raw = serde_json::to_string_pretty(value).map_err(|e| format!("JSON 序列化失败: {e}"))?;
  fs::write(&path, raw).map_err(|e| format!("写入文件失败 {:?}: {e}", path))
}

fn launch_project_path() -> Option<PathBuf> {
  env::args_os().skip(1).find_map(|arg| {
    let path = PathBuf::from(arg);
    if !path.exists() { return None; }
    if path.is_dir() { Some(path) } else { path.parent().map(|p| p.to_path_buf()) }
  })
}

#[tauri::command]
fn get_launch_context() -> LaunchContext {
  let project_path = launch_project_path().map(|p| p.to_string_lossy().to_string());
  LaunchContext { opened_from_context: project_path.is_some(), project_path }
}

fn should_omit_dir(name: &str) -> bool {
  matches!(
    name,
    ".git" | "node_modules" | "target" | "dist" | "build" | ".next" | ".vite" | "coverage" | "release"
  )
}

fn sorted_directory_entries(dir: &Path) -> Result<Vec<fs::DirEntry>, String> {
  let mut entries = fs::read_dir(dir)
    .map_err(|e| format!("读取目录失败 {:?}: {e}", dir))?
    .filter_map(|entry| entry.ok())
    .collect::<Vec<_>>();

  entries.sort_by(|a, b| {
    let a_is_dir = a.file_type().map(|t| t.is_dir()).unwrap_or(false);
    let b_is_dir = b.file_type().map(|t| t.is_dir()).unwrap_or(false);
    b_is_dir
      .cmp(&a_is_dir)
      .then_with(|| a.file_name().to_string_lossy().to_lowercase().cmp(&b.file_name().to_string_lossy().to_lowercase()))
  });

  Ok(entries)
}

fn push_directory_tree_lines(
  dir: &Path,
  prefix: &str,
  depth: usize,
  max_depth: usize,
  max_lines: usize,
  lines: &mut Vec<String>,
  truncated: &mut bool,
) -> Result<(), String> {
  if *truncated || depth >= max_depth {
    return Ok(());
  }

  let entries = sorted_directory_entries(dir)?;

  for (index, entry) in entries.iter().enumerate() {
    if lines.len() >= max_lines {
      lines.push(format!("{}… 已省略更多条目", prefix));
      *truncated = true;
      break;
    }

    let name = entry.file_name().to_string_lossy().to_string();
    let is_last = index + 1 == entries.len();
    let connector = if is_last { "└─ " } else { "├─ " };
    let child_prefix = if is_last { "   " } else { "│  " };
    let file_type = entry.file_type().map_err(|e| format!("读取文件类型失败 {:?}: {e}", entry.path()))?;

    if file_type.is_dir() {
      if should_omit_dir(&name) {
        lines.push(format!("{}{}{}/（已省略）", prefix, connector, name));
      } else {
        lines.push(format!("{}{}{}/", prefix, connector, name));
        push_directory_tree_lines(
          &entry.path(),
          &format!("{}{}", prefix, child_prefix),
          depth + 1,
          max_depth,
          max_lines,
          lines,
          truncated,
        )?;
      }
    } else {
      lines.push(format!("{}{}{}", prefix, connector, name));
    }
  }

  Ok(())
}

fn build_directory_tree_node(
  path: &Path,
  name: String,
  depth: usize,
  max_depth: usize,
  max_nodes: usize,
  node_count: &mut usize,
  truncated: &mut bool,
) -> Result<DirectoryTreeNode, String> {
  let is_dir = path.is_dir();
  let mut node = DirectoryTreeNode {
    name,
    path: path.to_string_lossy().to_string(),
    is_dir,
    omitted: false,
    children: vec![],
  };

  if !is_dir || *truncated || depth >= max_depth {
    return Ok(node);
  }

  for entry in sorted_directory_entries(path)? {
    if *node_count >= max_nodes {
      node.children.push(DirectoryTreeNode {
        name: "… 已省略更多条目".to_string(),
        path: path.to_string_lossy().to_string(),
        is_dir: false,
        omitted: true,
        children: vec![],
      });
      *truncated = true;
      break;
    }

    let child_path = entry.path();
    let child_name = entry.file_name().to_string_lossy().to_string();
    let file_type = entry.file_type().map_err(|e| format!("读取文件类型失败 {:?}: {e}", child_path))?;
    *node_count += 1;

    if file_type.is_dir() && should_omit_dir(&child_name) {
      node.children.push(DirectoryTreeNode {
        name: child_name,
        path: child_path.to_string_lossy().to_string(),
        is_dir: true,
        omitted: true,
        children: vec![],
      });
    } else {
      node.children.push(build_directory_tree_node(
        &child_path,
        child_name,
        depth + 1,
        max_depth,
        max_nodes,
        node_count,
        truncated,
      )?);
    }
  }

  Ok(node)
}

#[tauri::command]
fn open_path_in_file_manager(path: String) -> Result<(), String> {
  let raw_path = PathBuf::from(path.trim());
  if !raw_path.exists() {
    return Err(format!("路径不存在：{}", raw_path.to_string_lossy()));
  }
  let target = if raw_path.is_dir() {
    raw_path
  } else {
    raw_path
      .parent()
      .ok_or_else(|| format!("无法定位所在目录：{}", raw_path.to_string_lossy()))?
      .to_path_buf()
  };

  #[cfg(windows)]
  {
    Command::new("explorer.exe")
      .arg(&target)
      .spawn()
      .map_err(|e| format!("打开资源管理器失败：{e}"))?;
  }

  #[cfg(target_os = "macos")]
  {
    Command::new("open")
      .arg(&target)
      .spawn()
      .map_err(|e| format!("打开 Finder 失败：{e}"))?;
  }

  #[cfg(all(unix, not(target_os = "macos")))]
  {
    Command::new("xdg-open")
      .arg(&target)
      .spawn()
      .map_err(|e| format!("打开文件管理器失败：{e}"))?;
  }

  Ok(())
}

#[tauri::command]
fn open_file_with_default_app(path: String) -> Result<(), String> {
  let target = PathBuf::from(path.trim());
  if !target.exists() {
    return Err(format!("文件不存在：{}", target.to_string_lossy()));
  }
  if !target.is_file() {
    return Err(format!("不是文件：{}", target.to_string_lossy()));
  }

  #[cfg(windows)]
  {
    Command::new("cmd.exe")
      .arg("/C")
      .arg("start")
      .arg("")
      .arg(&target)
      .spawn()
      .map_err(|e| format!("打开文件失败：{e}"))?;
  }

  #[cfg(target_os = "macos")]
  {
    Command::new("open")
      .arg(&target)
      .spawn()
      .map_err(|e| format!("打开文件失败：{e}"))?;
  }

  #[cfg(all(unix, not(target_os = "macos")))]
  {
    Command::new("xdg-open")
      .arg(&target)
      .spawn()
      .map_err(|e| format!("打开文件失败：{e}"))?;
  }

  Ok(())
}

#[tauri::command]
fn get_directory_tree(path: String) -> Result<DirectoryTreeResponse, String> {
  let root = PathBuf::from(path.trim());
  if !root.exists() {
    return Err(format!("目录不存在：{}", root.to_string_lossy()));
  }
  if !root.is_dir() {
    return Err(format!("不是目录：{}", root.to_string_lossy()));
  }

  let root_name = root
    .file_name()
    .and_then(|name| name.to_str())
    .unwrap_or("当前项目")
    .to_string();
  let mut lines = vec![format!("{}/", root_name)];
  let mut truncated = false;
  push_directory_tree_lines(&root, "", 0, 4, 500, &mut lines, &mut truncated)?;

  let mut node_count = 1;
  let tree = build_directory_tree_node(&root, root_name, 0, 4, 500, &mut node_count, &mut truncated)?;

  Ok(DirectoryTreeResponse {
    root: root.to_string_lossy().to_string(),
    lines,
    tree,
    truncated,
  })
}

#[cfg(windows)]
fn register_windows_context_menu() -> Result<(), String> {
  use winreg::enums::HKEY_CURRENT_USER;
  use winreg::RegKey;

  let exe = env::current_exe().map_err(|e| format!("获取当前 exe 路径失败: {e}"))?;
  let exe = exe.to_string_lossy().to_string();
  let command = format!("\"{}\" \"%1\"", exe);
  let background_command = format!("\"{}\" \"%V\"", exe);
  let hkcu = RegKey::predef(HKEY_CURRENT_USER);

  for (key_path, cmd) in [
    ("Software\\Classes\\Directory\\shell\\OpenWithPiDesktop", command.as_str()),
    ("Software\\Classes\\Drive\\shell\\OpenWithPiDesktop", command.as_str()),
    ("Software\\Classes\\Directory\\Background\\shell\\OpenWithPiDesktop", background_command.as_str()),
  ] {
    let (key, _) = hkcu.create_subkey(key_path).map_err(|e| format!("创建右键菜单注册表失败 {key_path}: {e}"))?;
    key.set_value("", &"Open with Pi Desktop").map_err(|e| format!("写入右键菜单名称失败: {e}"))?;
    key.set_value("Icon", &exe).map_err(|e| format!("写入右键菜单图标失败: {e}"))?;
    let (command_key, _) = key.create_subkey("command").map_err(|e| format!("创建右键菜单命令失败: {e}"))?;
    command_key.set_value("", &cmd).map_err(|e| format!("写入右键菜单命令失败: {e}"))?;
  }

  Ok(())
}

#[cfg(not(windows))]
fn register_windows_context_menu() -> Result<(), String> { Ok(()) }

#[cfg(windows)]
fn windows_path_entries() -> Vec<PathBuf> {
  let mut entries = Vec::new();
  if let Some(path) = std::env::var_os("PATH") {
    entries.extend(std::env::split_paths(&path));
  }
  if let Some(appdata) = std::env::var_os("APPDATA") {
    entries.push(PathBuf::from(appdata).join("npm"));
  }
  if let Some(userprofile) = std::env::var_os("USERPROFILE") {
    entries.push(PathBuf::from(userprofile).join("AppData").join("Roaming").join("npm"));
  }
  if let Some(program_files) = std::env::var_os("ProgramFiles") {
    entries.push(PathBuf::from(program_files).join("nodejs"));
  }
  if let Some(program_files_x86) = std::env::var_os("ProgramFiles(x86)") {
    entries.push(PathBuf::from(program_files_x86).join("nodejs"));
  }
  entries
}

#[cfg(windows)]
fn windows_augmented_path() -> Option<std::ffi::OsString> {
  std::env::join_paths(windows_path_entries()).ok()
}

#[cfg(windows)]
fn split_windows_command_line(raw: &str) -> Vec<String> {
  let mut args = Vec::new();
  let mut current = String::new();
  let mut in_quotes = false;
  for ch in raw.chars() {
    match ch {
      '"' => in_quotes = !in_quotes,
      c if c.is_whitespace() && !in_quotes => {
        if !current.is_empty() {
          args.push(current.clone());
          current.clear();
        }
      }
      c => current.push(c),
    }
  }
  if !current.is_empty() {
    args.push(current);
  }
  args
}

#[cfg(windows)]
fn find_command_in_path(names: &[&str]) -> Option<PathBuf> {
  for dir in windows_path_entries() {
    for name in names {
      let candidate = dir.join(name);
      if candidate.exists() {
        return Some(candidate);
      }
    }
  }
  None
}

#[cfg(windows)]
fn find_windows_pi_command() -> Option<PathBuf> {
  find_command_in_path(&["pi.cmd", "pi.exe", "pi.bat", "pi.ps1", "pi"])
}

#[cfg(windows)]
fn find_windows_node_command() -> Option<PathBuf> {
  find_command_in_path(&["node.exe", "node.cmd", "node.bat"])
}

#[cfg(windows)]
fn is_pi_wrapper(path: &PathBuf) -> bool {
  path.file_name()
    .and_then(|s| s.to_str())
    .map(|name| matches!(name.to_ascii_lowercase().as_str(), "pi" | "pi.cmd" | "pi.exe" | "pi.bat" | "pi.ps1"))
    .unwrap_or(false)
}

#[cfg(windows)]
fn pi_cli_js_from_wrapper(wrapper: &PathBuf) -> Option<PathBuf> {
  let cli = wrapper
    .parent()?
    .join("node_modules")
    .join("@mariozechner")
    .join("pi-coding-agent")
    .join("dist")
    .join("cli.js");
  cli.exists().then_some(cli)
}

fn command_has_resume_flag(raw: &str) -> bool {
  raw.split_whitespace().any(|part| matches!(part, "--continue" | "-c" | "--resume" | "-r" | "--session" | "--fork"))
}

#[cfg(windows)]
fn build_pi_command(raw: &str, extra_args: &[String]) -> Result<CommandBuilder, String> {
  let raw = raw.trim();
  if raw.is_empty() {
    return Err("Pi 命令为空".to_string());
  }

  if raw.contains('\n') || raw.contains('\r') || raw.to_ascii_lowercase().starts_with("@echo") || raw.to_ascii_lowercase().starts_with("set ") {
    let scripts_dir = storage_dir()?.join("launch-scripts");
    fs::create_dir_all(&scripts_dir).map_err(|e| format!("创建启动脚本目录失败: {e}"))?;
    let script_path = scripts_dir.join("pi-launch.bat");
    let mut script = raw.replace('\r', "");
    if !script.ends_with('\n') { script.push('\n'); }
    fs::write(&script_path, script).map_err(|e| format!("写入启动脚本失败: {e}"))?;

    let mut cmd = CommandBuilder::new("cmd.exe");
    cmd.arg("/D");
    cmd.arg("/C");
    // 不要把带引号的 `call "..."` 拼成一个参数传给 cmd.exe。
    // portable-pty/CreateProcess 会再次转义内部引号，cmd 可能把
    // `"C:\...\pi-launch.bat"` 当成带反斜杠和引号的字面命令，导致
    // “不是内部或外部命令”。直接把脚本路径作为 /C 的命令参数交给
    // CommandBuilder 处理一次转义即可，含空格的用户目录也能正常启动。
    cmd.arg(script_path);
    cmd.args(extra_args);
    if let Some(path) = windows_augmented_path() {
      cmd.env("PATH", path);
    }
    cmd.env("FORCE_COLOR", "1");
    return Ok(cmd);
  }

  let parts = split_windows_command_line(raw);
  let (program, args) = parts.split_first().ok_or("Pi 命令为空")?;

  let resolved_program = if program.eq_ignore_ascii_case("pi") {
    find_windows_pi_command().unwrap_or_else(|| PathBuf::from(program))
  } else {
    PathBuf::from(program)
  };

  let mut cmd = if is_pi_wrapper(&resolved_program) {
    if let Some(cli_js) = pi_cli_js_from_wrapper(&resolved_program) {
      let node = find_windows_node_command().unwrap_or_else(|| PathBuf::from("node.exe"));
      let mut cmd = CommandBuilder::new(node);
      cmd.arg(cli_js);
      cmd.args(args);
      cmd.args(extra_args);
      cmd
    } else {
      let mut cmd = CommandBuilder::new(&resolved_program);
      cmd.args(args);
      cmd.args(extra_args);
      cmd
    }
  } else {
    let mut cmd = CommandBuilder::new(&resolved_program);
    cmd.args(args);
    cmd.args(extra_args);
    cmd
  };

  if let Some(path) = windows_augmented_path() {
    cmd.env("PATH", path);
  }
  cmd.env("FORCE_COLOR", "1");
  Ok(cmd)
}

#[cfg(not(windows))]
fn build_pi_command(raw: &str, extra_args: &[String]) -> Result<CommandBuilder, String> {
  let parts = shell_words::split(raw).map_err(|e| format!("Pi 命令解析失败: {e}"))?;
  let (program, args) = parts.split_first().ok_or("Pi 命令为空")?;
  let mut cmd = CommandBuilder::new(program);
  cmd.args(args);
  cmd.args(extra_args);
  Ok(cmd)
}

fn session_dir(session_id: &str) -> Result<PathBuf, String> {
  let safe = session_id
    .chars()
    .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
    .collect::<String>();
  let dir = storage_dir()?.join("pi-sessions").join(safe);
  fs::create_dir_all(&dir).map_err(|e| format!("创建 Pi 会话目录失败: {e}"))?;
  Ok(dir)
}

fn env_u64(name: &str, default: u64) -> u64 {
  std::env::var(name)
    .ok()
    .and_then(|value| value.trim().parse::<u64>().ok())
    .filter(|value| *value > 0)
    .unwrap_or(default)
}

fn terminal_log_tail_bytes() -> u64 {
  env_u64("PI_IDE_TERMINAL_LOG_TAIL_BYTES", 1024 * 1024)
}

fn terminal_log_path(session_id: &str) -> Result<PathBuf, String> {
  Ok(session_dir(session_id)?.join("terminal.log"))
}

fn append_terminal_log_bytes(path: &Path, data: &[u8]) -> Result<(), String> {
  if data.is_empty() {
    return Ok(());
  }
  let mut file = fs::OpenOptions::new()
    .create(true)
    .append(true)
    .open(path)
    .map_err(|e| format!("鍐欏叆缁堢鏃ュ織澶辫触 {:?}: {e}", path))?;
  file.write_all(data)
    .map_err(|e| format!("鍐欏叆缁堢鏃ュ織澶辫触 {:?}: {e}", path))
}

#[tauri::command]
fn append_terminal_log(session_id: String, data: String) -> Result<(), String> {
  if session_id.trim().is_empty() || data.is_empty() {
    return Ok(());
  }
  let path = terminal_log_path(&session_id)?;
  append_terminal_log_bytes(&path, data.as_bytes())
}

#[tauri::command]
fn read_terminal_log_tail(session_id: String, max_bytes: Option<u64>) -> Result<String, String> {
  if session_id.trim().is_empty() {
    return Ok(String::new());
  }
  let path = terminal_log_path(&session_id)?;
  if !path.exists() {
    return Ok(String::new());
  }
  let limit = max_bytes.unwrap_or_else(terminal_log_tail_bytes);
  if limit == 0 {
    return Ok(String::new());
  }
  let mut file = fs::File::open(&path).map_err(|e| format!("璇诲彇缁堢鏃ュ織澶辫触 {:?}: {e}", path))?;
  let len = file.metadata().map_err(|e| format!("璇诲彇缁堢鏃ュ織澶у皬澶辫触 {:?}: {e}", path))?.len();
  if len > limit {
    file.seek(SeekFrom::Start(len - limit))
      .map_err(|e| format!("瀹氫綅缁堢鏃ュ織澶辫触 {:?}: {e}", path))?;
  }
  let mut bytes = Vec::new();
  file.read_to_end(&mut bytes).map_err(|e| format!("璇诲彇缁堢鏃ュ織澶辫触 {:?}: {e}", path))?;
  Ok(String::from_utf8_lossy(&bytes).to_string())
}

#[tauri::command]
fn clear_terminal_log(session_id: String) -> Result<(), String> {
  if session_id.trim().is_empty() {
    return Ok(());
  }
  let path = terminal_log_path(&session_id)?;
  fs::write(&path, "").map_err(|e| format!("娓呯┖缁堢鏃ュ織澶辫触 {:?}: {e}", path))
}

#[tauri::command]
async fn start_pi_session(app: tauri::AppHandle, session_id: String, pi_command: Option<String>, workdir: Option<String>, continue_session: Option<bool>) -> Result<(), String> {
  if session_id.trim().is_empty() {
    return Err("sessionId 为空".to_string());
  }

  let workdir_path = workdir
    .as_deref()
    .map(str::trim)
    .filter(|s| !s.is_empty())
    .map(PathBuf::from);
  let debug_enabled = resolve_debug_logging_enabled(workdir_path.as_deref(), pi_command.as_deref())?;
  append_debug_line_when(debug_enabled, &format!("[backend] start_pi_session request session_id={session_id} workdir={:?} continue={:?}", workdir, continue_session));

  {
    let mut sessions = PI_SESSIONS.lock().await;
    if let Some(runtime) = sessions.get_mut(&session_id) {
      match runtime.child.try_wait() {
        Ok(None) => {
          append_debug_line_when(runtime.debug_enabled, &format!("[backend] start_pi_session already_running session_id={session_id}"));
          let _ = app.emit("pi-status", serde_json::json!({ "sessionId": session_id, "status": "Pi 已经在运行" }));
          return Ok(());
        }
        Ok(Some(status)) => {
          append_debug_line_when(runtime.debug_enabled, &format!("[backend] start_pi_session stale_child session_id={session_id} status={status}"));
          sessions.remove(&session_id);
        }
        Err(e) => {
          append_debug_line_when(runtime.debug_enabled, &format!("[backend] start_pi_session try_wait_error session_id={session_id} error={e}"));
          sessions.remove(&session_id);
        }
      }
    }
  }

  let (raw, config_envs, config_info) = resolve_pi_launch_config(workdir_path.as_deref(), pi_command.as_deref())?;
  let extra_args = if continue_session.unwrap_or(false) && !command_has_resume_flag(&raw) {
    vec!["--continue".to_string()]
  } else {
    vec![]
  };
  append_debug_line_when(debug_enabled, &format!("[backend] start_pi_session build command session_id={session_id} command_len={} extra_args={:?} config={}", raw.len(), extra_args, config_info));
  let mut cmd = build_pi_command(&raw, &extra_args)?;
  let session_dir = session_dir(&session_id)?;
  let run_id = format!("pi-run-{}-{}", chrono::Utc::now().timestamp_millis(), session_id);
  cmd.env("PI_CODING_AGENT_SESSION_DIR", session_dir.to_string_lossy().to_string());
  cmd.env("PI_IDE_SESSION_ID", session_id.clone());
  cmd.env("PI_IDE_RUN_ID", run_id.clone());
  for (key, value) in config_envs {
    cmd.env(key, value);
  }

  if let Some(dir_path) = workdir_path.as_ref() {
    ensure_pi_ide_file_tracker(dir_path)?;
    cmd.cwd(dir_path);
  }

  let pty_system = native_pty_system();
  let pair = pty_system.openpty(PtySize {
    rows: 30,
    cols: 120,
    pixel_width: 0,
    pixel_height: 0,
  }).map_err(|e| format!("创建伪终端失败: {e}"))?;

  let child = pair.slave.spawn_command(cmd)
    .map_err(|e| format!("启动 Pi 失败。请确认已安装 pi.dev CLI，并且命令 `{raw}` 可执行。系统错误: {e}"))?;
  let mut reader = pair.master.try_clone_reader().map_err(|e| format!("无法打开 Pi PTY reader: {e}"))?;
  let writer = pair.master.take_writer().map_err(|e| format!("无法打开 Pi PTY writer: {e}"))?;

  PI_SESSIONS.lock().await.insert(session_id.clone(), PiRuntime { writer, child, master: pair.master, debug_enabled });
  append_debug_line_when(debug_enabled, &format!("[backend] start_pi_session spawned session_id={session_id}"));
  let _ = app.emit("pi-status", serde_json::json!({ "sessionId": session_id, "runId": run_id, "status": format!("Pi 已启动：{}", raw) }));

  let out_app = app.clone();
  let out_session_id = session_id.clone();
  let out_terminal_log_path = session_dir.join("terminal.log");
  let out_debug_enabled = debug_enabled;
  std::thread::spawn(move || {
    let mut buf = vec![0u8; 8192];
    loop {
      match reader.read(&mut buf) {
        Ok(0) => {
          append_debug_line_when(out_debug_enabled, &format!("[backend] pi-output eof session_id={}", out_session_id));
          let _ = out_app.emit("pi-status", serde_json::json!({
            "sessionId": out_session_id,
            "status": "Pi 已退出"
          }));
          break;
        }
        Ok(n) => {
          let _ = append_terminal_log_bytes(&out_terminal_log_path, &buf[..n]);
          append_debug_line_when(out_debug_enabled, &format!("[backend] pi-output session_id={} bytes={}", out_session_id, n));
          let _ = out_app.emit("pi-output", serde_json::json!({
            "sessionId": out_session_id,
            "data": String::from_utf8_lossy(&buf[..n]).to_string()
          }));
        }
        Err(e) => {
          append_debug_line_when(out_debug_enabled, &format!("[backend] pi-output error session_id={} error={}", out_session_id, e));
          let _ = out_app.emit("pi-output", serde_json::json!({
            "sessionId": out_session_id,
            "data": format!("\r\n[PTY 读取错误] {e}\r\n")
          }));
          let _ = out_app.emit("pi-status", serde_json::json!({
            "sessionId": out_session_id,
            "status": "Pi 已退出"
          }));
          break;
        }
      }
    }
  });

  Ok(())
}

#[tauri::command]
async fn send_pi_input(session_id: String, input: String) -> Result<(), String> {
  let mut sessions = PI_SESSIONS.lock().await;
  let runtime = sessions.get_mut(&session_id).ok_or("当前会话 Pi 尚未启动")?;
  append_debug_line_when(runtime.debug_enabled, &format!("[backend] send_pi_input session_id={session_id} bytes={}", input.len()));
  runtime.writer.write_all(input.as_bytes()).map_err(|e| format!("写入 Pi PTY 失败: {e}"))?;
  runtime.writer.flush().map_err(|e| format!("刷新 Pi PTY 失败: {e}"))
}

async fn stop_pi_session_runtime(session_id: &str) {
  let mut sessions = PI_SESSIONS.lock().await;
  if let Some(mut runtime) = sessions.remove(session_id) {
    append_debug_line_when(runtime.debug_enabled, &format!("[backend] stop_pi_session_runtime session_id={session_id}"));
    let _ = runtime.child.kill();
  }
}

async fn stop_all_pi_sessions_runtime() {
  let mut sessions = PI_SESSIONS.lock().await;
  for (session_id, mut runtime) in sessions.drain() {
    append_debug_line_when(runtime.debug_enabled, &format!("[backend] stop_all_pi_sessions_runtime session_id={session_id}"));
    let _ = runtime.child.kill();
  }
}

#[tauri::command]
async fn stop_pi_session(app: tauri::AppHandle, session_id: String) -> Result<(), String> {
  stop_pi_session_runtime(&session_id).await;
  let _ = app.emit("pi-status", serde_json::json!({ "sessionId": session_id, "status": "Pi 已停止" }));
  Ok(())
}

#[tauri::command]
async fn stop_all_pi_sessions(app: tauri::AppHandle) -> Result<(), String> {
  stop_all_pi_sessions_runtime().await;
  let _ = app.emit("pi-status", serde_json::json!({ "sessionId": serde_json::Value::Null, "status": "所有 Pi 已停止" }));
  Ok(())
}

#[tauri::command]
async fn resize_pi(session_id: String, cols: u16, rows: u16) -> Result<(), String> {
  let sessions = PI_SESSIONS.lock().await;
  if let Some(runtime) = sessions.get(&session_id) {
    runtime.master.resize(PtySize {
      rows: rows.max(1),
      cols: cols.max(1),
      pixel_width: 0,
      pixel_height: 0,
    }).map_err(|e| format!("调整 Pi 终端尺寸失败: {e}"))?;
  }
  Ok(())
}

#[tauri::command]
fn load_history() -> Result<Vec<HistoryItem>, String> { read_json_array(history_path()?) }

#[tauri::command]
fn append_history(command: String) -> Result<Vec<HistoryItem>, String> {
  let mut items: Vec<HistoryItem> = read_json_array(history_path()?)?;
  if !command.trim().is_empty() {
    items.push(HistoryItem { command, created_at: now_iso() });
  }
  if items.len() > 500 { items = items[items.len() - 500..].to_vec(); }
  write_json_array(history_path()?, &items)?;
  Ok(items)
}

#[tauri::command]
fn clear_history() -> Result<(), String> { write_json_array::<HistoryItem>(history_path()?, &vec![]) }

#[tauri::command]
fn load_sessions() -> Result<Vec<SessionNode>, String> { read_json_array(sessions_path()?) }

#[tauri::command]
fn append_session_node(parent_id: Option<String>, title: String, command: String) -> Result<Vec<SessionNode>, String> {
  let mut nodes: Vec<SessionNode> = read_json_array(sessions_path()?)?;
  let id = format!("node-{}-{}", chrono::Utc::now().timestamp_millis(), nodes.len() + 1);
  nodes.push(SessionNode { id, parent_id, title, command, created_at: now_iso() });
  write_json_array(sessions_path()?, &nodes)?;
  Ok(nodes)
}

#[tauri::command]
fn delete_session_node(id: String) -> Result<Vec<SessionNode>, String> {
  let nodes: Vec<SessionNode> = read_json_array(sessions_path()?)?;
  let mut delete_ids = std::collections::HashSet::new();
  delete_ids.insert(id.clone());

  let mut changed = true;
  while changed {
    changed = false;
    for node in &nodes {
      if let Some(parent_id) = &node.parent_id {
        if delete_ids.contains(parent_id) && delete_ids.insert(node.id.clone()) {
          changed = true;
        }
      }
    }
  }

  let kept: Vec<SessionNode> = nodes.into_iter().filter(|node| !delete_ids.contains(&node.id)).collect();
  write_json_array(sessions_path()?, &kept)?;
  Ok(kept)
}

#[tauri::command]
fn clear_sessions() -> Result<(), String> { write_json_array::<SessionNode>(sessions_path()?, &vec![]) }

#[tauri::command]
fn get_storage_paths() -> Result<serde_json::Value, String> {
  Ok(serde_json::json!({
    "dir": storage_dir()?.to_string_lossy(),
    "history": history_path()?.to_string_lossy(),
    "sessions": sessions_path()?.to_string_lossy(),
    "config": global_config_path()?.to_string_lossy()
  }))
}

fn read_jsonl_values(path: PathBuf) -> Result<Vec<serde_json::Value>, String> {
  if !path.exists() {
    return Ok(vec![]);
  }
  let raw = fs::read_to_string(&path).map_err(|e| format!("读取 JSONL 失败 {:?}: {e}", path))?;
  let mut events = Vec::new();
  for line in raw.lines().filter(|line| !line.trim().is_empty()) {
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(line) {
      events.push(value);
    }
  }
  Ok(events)
}

fn read_jsonl_values_incremental(path: PathBuf) -> Result<Vec<serde_json::Value>, String> {
  if !path.exists() {
    return Ok(vec![]);
  }

  let key = path.to_string_lossy().to_string();
  let len = fs::metadata(&path).map_err(|e| format!("璇诲彇 JSONL 澶у皬澶辫触 {:?}: {e}", path))?.len();
  let start = {
    let mut offsets = PI_EVENT_OFFSETS.lock().map_err(|_| "JSONL offset lock poisoned".to_string())?;
    let saved = *offsets.get(&key).unwrap_or(&0);
    if len < saved {
      offsets.insert(key.clone(), 0);
      0
    } else {
      saved
    }
  };

  if start == len {
    return Ok(vec![]);
  }

  if start == 0 {
    let events = read_jsonl_values(path.clone())?;
    let mut offsets = PI_EVENT_OFFSETS.lock().map_err(|_| "JSONL offset lock poisoned".to_string())?;
    offsets.insert(key, len);
    return Ok(events);
  }

  let mut file = fs::File::open(&path).map_err(|e| format!("璇诲彇 JSONL 澶辫触 {:?}: {e}", path))?;
  file.seek(SeekFrom::Start(start)).map_err(|e| format!("瀹氫綅 JSONL 澶辫触 {:?}: {e}", path))?;
  let mut raw = String::new();
  file.read_to_string(&mut raw).map_err(|e| format!("璇诲彇 JSONL 澶辫触 {:?}: {e}", path))?;

  let mut next_offset = start + raw.len() as u64;
  if !raw.is_empty() && !raw.ends_with('\n') {
    if let Some(index) = raw.rfind('\n') {
      raw.truncate(index + 1);
      next_offset = start + index as u64 + 1;
    } else {
      raw.clear();
      next_offset = start;
    }
  }

  let mut events = Vec::new();
  for line in raw.lines().filter(|line| !line.trim().is_empty()) {
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(line) {
      events.push(value);
    }
  }

  let mut offsets = PI_EVENT_OFFSETS.lock().map_err(|_| "JSONL offset lock poisoned".to_string())?;
  offsets.insert(key, next_offset);
  Ok(events)
}

#[tauri::command]
fn load_pi_ide_file_events(workdir: String) -> Result<Vec<serde_json::Value>, String> {
  let dir = PathBuf::from(workdir.trim());
  if !dir.exists() || !dir.is_dir() {
    return Ok(vec![]);
  }
  read_jsonl_values_incremental(pi_ide_file_events_path(&dir))
}

#[tauri::command]
fn load_pi_ide_events(workdir: String) -> Result<Vec<serde_json::Value>, String> {
  let dir = PathBuf::from(workdir.trim());
  if !dir.exists() || !dir.is_dir() {
    return Ok(vec![]);
  }
  read_jsonl_values_incremental(pi_ide_events_path(&dir))
}

fn main() {
  tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_clipboard_manager::init())
    .invoke_handler(tauri::generate_handler![
      get_launch_context,
      ensure_pi_ide_config,
      append_debug_log,
      get_debug_log_path,
      get_debug_logging_config,
      open_path_in_file_manager,
      open_file_with_default_app,
      get_directory_tree,
      append_terminal_log,
      read_terminal_log_tail,
      clear_terminal_log,
      start_pi_session,
      send_pi_input,
      stop_pi_session,
      stop_all_pi_sessions,
      resize_pi,
      load_history,
      append_history,
      clear_history,
      load_sessions,
      append_session_node,
      delete_session_node,
      clear_sessions,
      get_storage_paths,
      load_pi_ide_file_events,
      load_pi_ide_events
    ])
    .setup(|app| {
      if let Err(e) = register_windows_context_menu() {
        eprintln!("register context menu failed: {e}");
      }
      let handle = app.handle().clone();
      tauri::async_runtime::spawn(async move {
        let _ = handle.emit("pi-status", "Pi IDE 已就绪");
      });
      Ok(())
    })
    .on_window_event(|_window, event| {
      if let tauri::WindowEvent::CloseRequested { .. } = event {
        tauri::async_runtime::block_on(async {
          stop_all_pi_sessions_runtime().await;
        });
      }
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
