#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use once_cell::sync::Lazy;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, env, fs, io::{Read, Write}, path::{Path, PathBuf}, process::Command};
use tauri::Emitter;
use tokio::sync::Mutex;

struct PiRuntime {
  writer: Box<dyn Write + Send>,
  child: Box<dyn Child + Send + Sync>,
  master: Box<dyn MasterPty + Send>,
}

static PI_SESSIONS: Lazy<Mutex<HashMap<String, PiRuntime>>> = Lazy::new(|| Mutex::new(HashMap::new()));

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

fn append_debug_line(line: &str) {
  if let Ok(path) = debug_log_path() {
    if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(path) {
      let _ = writeln!(file, "{} {}", now_iso(), line);
    }
  }
}

#[tauri::command]
fn append_debug_log(source: String, message: String) -> Result<(), String> {
  append_debug_line(&format!("[{source}] {message}"));
  Ok(())
}

#[tauri::command]
fn get_debug_log_path() -> Result<String, String> {
  Ok(debug_log_path()?.to_string_lossy().to_string())
}

const PI_IDE_BRIDGE_EXTENSION: &str = r#"import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

const bashBefore = new Map();
let sequence = 0;

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
    content: result?.content || [],
    details: result?.details || {},
  };
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
  pi.on("session_start", async (_event, ctx) => {
    appendEvent(ctx, { kind: "session", source: "session-start" });
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
      text: textContent(event.message),
      toolResults: event.toolResults?.map(compactResult) || [],
    });
  });

  pi.on("message_update", async (event, ctx) => {
    const delta = event.assistantMessageEvent || {};
    appendTimeline(ctx, event.type, {
      messageId: event.message?.id,
      deltaType: delta.type,
      contentIndex: delta.contentIndex,
      delta: delta.delta || "",
      content: delta.content || "",
      reason: delta.reason || "",
      text: textContent(event.message),
      toolCall: delta.toolCall || undefined,
    });
  });

  pi.on("message_end", async (event, ctx) => {
    appendTimeline(ctx, event.type, {
      messageId: event.message?.id,
      text: textContent(event.message),
      messageRole: event.message?.role,
    });
  });

  pi.on("tool_execution_start", async (event, ctx) => {
    appendTimeline(ctx, event.type, {
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      args: event.args || {},
    });
  });

  pi.on("tool_execution_update", async (event, ctx) => {
    appendTimeline(ctx, event.type, {
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      args: event.args || {},
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
    if (event.toolName === "bash") {
      bashBefore.set(event.toolCallId, gitChangedFiles(ctx.cwd));
    }
  });

  pi.on("tool_result", async (event, ctx) => {
    if (event.isError) return;
    const input = event.input || {};
    const toolName = event.toolName;
    const toolCallId = event.toolCallId;

    if (toolName === "read") {
      recordPath(ctx, "reference", "pi-tool-read", toolCallId, toolName, input.path);
      return;
    }

    if (toolName === "write") {
      recordPath(ctx, "output", "pi-tool-write", toolCallId, toolName, input.path);
      return;
    }

    if (toolName === "edit") {
      recordPath(ctx, "output", "pi-tool-edit", toolCallId, toolName, input.path);
      return;
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

#[tauri::command]
async fn start_pi_session(app: tauri::AppHandle, session_id: String, pi_command: Option<String>, workdir: Option<String>, continue_session: Option<bool>) -> Result<(), String> {
  append_debug_line(&format!("[backend] start_pi_session request session_id={session_id} workdir={:?} continue={:?}", workdir, continue_session));
  if session_id.trim().is_empty() {
    return Err("sessionId 为空".to_string());
  }

  {
    let mut sessions = PI_SESSIONS.lock().await;
    if let Some(runtime) = sessions.get_mut(&session_id) {
      match runtime.child.try_wait() {
        Ok(None) => {
          append_debug_line(&format!("[backend] start_pi_session already_running session_id={session_id}"));
          let _ = app.emit("pi-status", serde_json::json!({ "sessionId": session_id, "status": "Pi 已经在运行" }));
          return Ok(());
        }
        Ok(Some(status)) => {
          append_debug_line(&format!("[backend] start_pi_session stale_child session_id={session_id} status={status}"));
          sessions.remove(&session_id);
        }
        Err(e) => {
          append_debug_line(&format!("[backend] start_pi_session try_wait_error session_id={session_id} error={e}"));
          sessions.remove(&session_id);
        }
      }
    }
  }

  let raw = pi_command
    .filter(|s| !s.trim().is_empty())
    .or_else(|| std::env::var("PI_IDE_PI_BIN").ok())
    .unwrap_or_else(|| "pi".to_string());
  let extra_args = if continue_session.unwrap_or(false) && !command_has_resume_flag(&raw) {
    vec!["--continue".to_string()]
  } else {
    vec![]
  };
  append_debug_line(&format!("[backend] start_pi_session build command session_id={session_id} command_len={} extra_args={:?}", raw.len(), extra_args));
  let mut cmd = build_pi_command(&raw, &extra_args)?;
  let session_dir = session_dir(&session_id)?;
  let run_id = format!("pi-run-{}-{}", chrono::Utc::now().timestamp_millis(), session_id);
  cmd.env("PI_CODING_AGENT_SESSION_DIR", session_dir.to_string_lossy().to_string());
  cmd.env("PI_IDE_SESSION_ID", session_id.clone());
  cmd.env("PI_IDE_RUN_ID", run_id.clone());

  if let Some(dir) = workdir.filter(|s| !s.trim().is_empty()) {
    let dir_path = PathBuf::from(&dir);
    ensure_pi_ide_file_tracker(&dir_path)?;
    cmd.cwd(dir);
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

  PI_SESSIONS.lock().await.insert(session_id.clone(), PiRuntime { writer, child, master: pair.master });
  append_debug_line(&format!("[backend] start_pi_session spawned session_id={session_id}"));
  let _ = app.emit("pi-status", serde_json::json!({ "sessionId": session_id, "runId": run_id, "status": format!("Pi 已启动：{}", raw) }));

  let out_app = app.clone();
  let out_session_id = session_id.clone();
  std::thread::spawn(move || {
    let mut buf = vec![0u8; 8192];
    loop {
      match reader.read(&mut buf) {
        Ok(0) => break,
        Ok(n) => {
          append_debug_line(&format!("[backend] pi-output session_id={} bytes={}", out_session_id, n));
          let _ = out_app.emit("pi-output", serde_json::json!({
            "sessionId": out_session_id,
            "data": String::from_utf8_lossy(&buf[..n]).to_string()
          }));
        }
        Err(e) => {
          let _ = out_app.emit("pi-output", serde_json::json!({
            "sessionId": out_session_id,
            "data": format!("\r\n[PTY 读取错误] {e}\r\n")
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
  append_debug_line(&format!("[backend] send_pi_input session_id={session_id} bytes={}", input.len()));
  let mut sessions = PI_SESSIONS.lock().await;
  let runtime = sessions.get_mut(&session_id).ok_or("当前会话 Pi 尚未启动")?;
  runtime.writer.write_all(input.as_bytes()).map_err(|e| format!("写入 Pi PTY 失败: {e}"))?;
  runtime.writer.flush().map_err(|e| format!("刷新 Pi PTY 失败: {e}"))
}

async fn stop_pi_session_runtime(session_id: &str) {
  append_debug_line(&format!("[backend] stop_pi_session_runtime session_id={session_id}"));
  let mut sessions = PI_SESSIONS.lock().await;
  if let Some(mut runtime) = sessions.remove(session_id) {
    let _ = runtime.child.kill();
  }
}

async fn stop_all_pi_sessions_runtime() {
  append_debug_line("[backend] stop_all_pi_sessions_runtime");
  let mut sessions = PI_SESSIONS.lock().await;
  for (_, mut runtime) in sessions.drain() {
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
    "sessions": sessions_path()?.to_string_lossy()
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

#[tauri::command]
fn load_pi_ide_file_events(workdir: String) -> Result<Vec<serde_json::Value>, String> {
  let dir = PathBuf::from(workdir.trim());
  if !dir.exists() || !dir.is_dir() {
    return Ok(vec![]);
  }
  read_jsonl_values(pi_ide_file_events_path(&dir))
}

#[tauri::command]
fn load_pi_ide_events(workdir: String) -> Result<Vec<serde_json::Value>, String> {
  let dir = PathBuf::from(workdir.trim());
  if !dir.exists() || !dir.is_dir() {
    return Ok(vec![]);
  }
  read_jsonl_values(pi_ide_events_path(&dir))
}

fn main() {
  tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_clipboard_manager::init())
    .invoke_handler(tauri::generate_handler![
      get_launch_context,
      append_debug_log,
      get_debug_log_path,
      open_path_in_file_manager,
      open_file_with_default_app,
      get_directory_tree,
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
