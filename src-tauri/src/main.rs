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
  children_loaded: bool,
  has_more: bool,
  children: Vec<DirectoryTreeNode>,
}

#[derive(Debug, Serialize)]
struct DirectoryTreeResponse {
  root: String,
  lines: Vec<String>,
  tree: DirectoryTreeNode,
  truncated: bool,
}

#[derive(Debug, Serialize)]
struct DirectoryTreeChildrenResponse {
  path: String,
  children: Vec<DirectoryTreeNode>,
  truncated: bool,
}

#[derive(Clone, Copy)]
struct DirectoryTreeConfig {
  initial_depth: usize,
  max_entries_per_directory: usize,
  preview_max_depth: usize,
  preview_max_lines: usize,
}

const DEFAULT_DIRECTORY_TREE_INITIAL_DEPTH: usize = 0;
const DEFAULT_DIRECTORY_TREE_MAX_ENTRIES_PER_DIRECTORY: usize = 160;
const DEFAULT_DIRECTORY_TREE_PREVIEW_MAX_DEPTH: usize = 0;
const DEFAULT_DIRECTORY_TREE_PREVIEW_MAX_LINES: usize = 0;
const DEFAULT_BACKGROUND_PI_IDLE_STOP_MINUTES: u64 = 5;
const DEFAULT_EVENT_TEXT_LIMIT: u64 = 50 * 1024;
const DEFAULT_TOOL_RESULT_TEXT_LIMIT: u64 = 50 * 1024;
const DEFAULT_PROJECT_EVENT_MAX_BYTES: u64 = 5 * 1024 * 1024;
const DEFAULT_TERMINAL_LOG_MAX_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Clone)]
struct StorageConfig {
  event_text_limit: u64,
  tool_result_text_limit: u64,
  project_event_max_bytes: u64,
  terminal_log_max_bytes: u64,
  event_mode: String,
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
fn pi_agent_dir() -> Result<PathBuf, String> {
  let home = dirs::home_dir().ok_or("无法定位用户 Home 目录")?;
  Ok(home.join(".pi").join("agent"))
}
fn global_pi_settings_path() -> Result<PathBuf, String> { Ok(pi_agent_dir()?.join("settings.json")) }
fn global_pi_models_path() -> Result<PathBuf, String> { Ok(pi_agent_dir()?.join("models.json")) }
fn global_pi_auth_path() -> Result<PathBuf, String> { Ok(pi_agent_dir()?.join("auth.json")) }
fn project_pi_settings_path(workdir: &Path) -> PathBuf { workdir.join(".pi").join("settings.json") }

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
fn append_debug_log(source: String, message: String, workdir: Option<String>, force: Option<bool>) -> Result<(), String> {
  let workdir_path = workdir
    .as_deref()
    .map(str::trim)
    .filter(|s| !s.is_empty())
    .map(PathBuf::from);
  if force.unwrap_or(false) || resolve_debug_logging_enabled(workdir_path.as_deref(), None)? {
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
    },
    "piSession": {
      "backgroundIdleStopMinutes": DEFAULT_BACKGROUND_PI_IDLE_STOP_MINUTES
    },
    "storage": {
      "eventMode": "compact",
      "eventTextLimit": DEFAULT_EVENT_TEXT_LIMIT,
      "toolResultTextLimit": DEFAULT_TOOL_RESULT_TEXT_LIMIT,
      "projectEventMaxBytes": DEFAULT_PROJECT_EVENT_MAX_BYTES,
      "terminalLogMaxBytes": DEFAULT_TERMINAL_LOG_MAX_BYTES
    },
    "directoryTree": {
      "initialDepth": DEFAULT_DIRECTORY_TREE_INITIAL_DEPTH,
      "maxEntriesPerDirectory": DEFAULT_DIRECTORY_TREE_MAX_ENTRIES_PER_DIRECTORY,
      "previewMaxDepth": DEFAULT_DIRECTORY_TREE_PREVIEW_MAX_DEPTH,
      "previewMaxLines": DEFAULT_DIRECTORY_TREE_PREVIEW_MAX_LINES
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
    },
    "piSession": {
      "backgroundIdleStopMinutes": DEFAULT_BACKGROUND_PI_IDLE_STOP_MINUTES
    },
    "storage": {
      "eventMode": "compact",
      "eventTextLimit": DEFAULT_EVENT_TEXT_LIMIT,
      "toolResultTextLimit": DEFAULT_TOOL_RESULT_TEXT_LIMIT,
      "projectEventMaxBytes": DEFAULT_PROJECT_EVENT_MAX_BYTES,
      "terminalLogMaxBytes": DEFAULT_TERMINAL_LOG_MAX_BYTES
    },
    "directoryTree": {
      "initialDepth": DEFAULT_DIRECTORY_TREE_INITIAL_DEPTH,
      "maxEntriesPerDirectory": DEFAULT_DIRECTORY_TREE_MAX_ENTRIES_PER_DIRECTORY,
      "previewMaxDepth": DEFAULT_DIRECTORY_TREE_PREVIEW_MAX_DEPTH,
      "previewMaxLines": DEFAULT_DIRECTORY_TREE_PREVIEW_MAX_LINES
    }
  })
}

fn read_json_value(path: &Path) -> Result<Option<serde_json::Value>, String> {
  if !path.exists() { return Ok(None); }
  let raw = fs::read_to_string(path).map_err(|e| format!("读取配置失败 {:?}: {e}", path))?;
  let raw = raw.trim_start_matches('\u{feff}');
  if raw.trim().is_empty() { return Ok(None); }
  let value = serde_json::from_str::<serde_json::Value>(raw)
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

fn ensure_directory_tree_config(value: &mut serde_json::Value) -> bool {
  let Some(map) = value.as_object_mut() else {
    return false;
  };
  let default_value = serde_json::json!({
    "initialDepth": DEFAULT_DIRECTORY_TREE_INITIAL_DEPTH,
    "maxEntriesPerDirectory": DEFAULT_DIRECTORY_TREE_MAX_ENTRIES_PER_DIRECTORY,
    "previewMaxDepth": DEFAULT_DIRECTORY_TREE_PREVIEW_MAX_DEPTH,
    "previewMaxLines": DEFAULT_DIRECTORY_TREE_PREVIEW_MAX_LINES
  });
  let Some(directory_tree) = map.get_mut("directoryTree") else {
    map.insert("directoryTree".to_string(), default_value);
    return true;
  };
  let Some(directory_tree_map) = directory_tree.as_object_mut() else {
    *directory_tree = default_value;
    return true;
  };

  let mut changed = false;
  for (key, fallback, allow_zero) in [
    ("initialDepth", DEFAULT_DIRECTORY_TREE_INITIAL_DEPTH, true),
    ("maxEntriesPerDirectory", DEFAULT_DIRECTORY_TREE_MAX_ENTRIES_PER_DIRECTORY, false),
    ("previewMaxDepth", DEFAULT_DIRECTORY_TREE_PREVIEW_MAX_DEPTH, true),
    ("previewMaxLines", DEFAULT_DIRECTORY_TREE_PREVIEW_MAX_LINES, true),
  ] {
    let valid = directory_tree_map
      .get(key)
      .and_then(|value| value.as_u64())
      .is_some_and(|value| if allow_zero { true } else { value > 0 });
    if !valid {
      directory_tree_map.insert(key.to_string(), serde_json::json!(fallback));
      changed = true;
    }
  }
  changed
}

fn ensure_pi_session_config(value: &mut serde_json::Value) -> bool {
  let Some(map) = value.as_object_mut() else {
    return false;
  };
  let default_value = serde_json::json!({
    "backgroundIdleStopMinutes": DEFAULT_BACKGROUND_PI_IDLE_STOP_MINUTES
  });
  let Some(pi_session) = map.get_mut("piSession") else {
    map.insert("piSession".to_string(), default_value);
    return true;
  };
  let Some(pi_session_map) = pi_session.as_object_mut() else {
    *pi_session = default_value;
    return true;
  };
  if !matches!(pi_session_map.get("backgroundIdleStopMinutes"), Some(value) if value.as_u64().is_some()) {
    pi_session_map.insert("backgroundIdleStopMinutes".to_string(), serde_json::json!(DEFAULT_BACKGROUND_PI_IDLE_STOP_MINUTES));
    return true;
  }
  false
}

fn ensure_storage_config(value: &mut serde_json::Value) -> bool {
  let Some(map) = value.as_object_mut() else {
    return false;
  };
  let default_value = serde_json::json!({
    "eventMode": "compact",
    "eventTextLimit": DEFAULT_EVENT_TEXT_LIMIT,
    "toolResultTextLimit": DEFAULT_TOOL_RESULT_TEXT_LIMIT,
    "projectEventMaxBytes": DEFAULT_PROJECT_EVENT_MAX_BYTES,
    "terminalLogMaxBytes": DEFAULT_TERMINAL_LOG_MAX_BYTES
  });
  let Some(storage) = map.get_mut("storage") else {
    map.insert("storage".to_string(), default_value);
    return true;
  };
  let Some(storage_map) = storage.as_object_mut() else {
    *storage = default_value;
    return true;
  };

  let mut changed = false;
  if !matches!(storage_map.get("eventMode").and_then(|value| value.as_str()), Some("compact" | "full" | "off")) {
    storage_map.insert("eventMode".to_string(), serde_json::json!("compact"));
    changed = true;
  }
  for (key, fallback, allow_zero) in [
    ("eventTextLimit", DEFAULT_EVENT_TEXT_LIMIT, false),
    ("toolResultTextLimit", DEFAULT_TOOL_RESULT_TEXT_LIMIT, false),
    ("projectEventMaxBytes", DEFAULT_PROJECT_EVENT_MAX_BYTES, true),
    ("terminalLogMaxBytes", DEFAULT_TERMINAL_LOG_MAX_BYTES, true),
  ] {
    let valid = storage_map
      .get(key)
      .and_then(|value| value.as_u64())
      .is_some_and(|value| if allow_zero { true } else { value > 0 });
    if !valid {
      storage_map.insert(key.to_string(), serde_json::json!(fallback));
      changed = true;
    }
  }
  changed
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
  let debug_changed = ensure_debug_config(&mut value);
  let directory_tree_changed = ensure_directory_tree_config(&mut value);
  let pi_session_changed = ensure_pi_session_config(&mut value);
  let storage_changed = ensure_storage_config(&mut value);
  let changed = debug_changed || directory_tree_changed || pi_session_changed || storage_changed;
  if changed {
    write_json_value(path, &value)?;
  }
  Ok(())
}

#[cfg(test)]
mod config_tests {
  use super::*;

  #[test]
  fn read_json_value_accepts_utf8_bom() {
    let path = env::temp_dir().join(format!("pi-ide-config-bom-{}.json", std::process::id()));
    fs::write(&path, b"\xEF\xBB\xBF{\"debug\":{\"enabled\":true}}").unwrap();
    let value = read_json_value(&path).unwrap().unwrap();
    let _ = fs::remove_file(&path);
    assert_eq!(value["debug"]["enabled"], true);
  }

  #[test]
  fn clear_project_cache_files_skips_invalid_directory() {
    let mut items = Vec::new();
    let mut skipped = Vec::new();
    let path = env::temp_dir().join(format!("pi-ide-missing-project-{}", std::process::id()));
    clear_project_cache_files(&path.to_string_lossy(), &mut items, &mut skipped).unwrap();
    assert!(items.is_empty());
    assert_eq!(skipped.len(), 1);
  }

  #[test]
  fn clear_cache_file_truncates_existing_file() {
    let mut items = Vec::new();
    let path = env::temp_dir().join(format!("pi-ide-cache-file-{}.log", std::process::id()));
    fs::write(&path, b"cache-data").unwrap();
    clear_cache_file(&mut items, &path, "test-cache").unwrap();
    let len = fs::metadata(&path).unwrap().len();
    let _ = fs::remove_file(&path);
    assert_eq!(len, 0);
    assert_eq!(items.len(), 1);
  }

  #[test]
  fn bridge_extension_handles_non_array_content() {
    let path = env::temp_dir().join(format!("pi-ide-bridge-content-{}.mjs", std::process::id()));
    let script = format!("{PI_IDE_BRIDGE_EXTENSION}\n{}", r#"
if (textContent({ content: "plain text" }) !== "plain text") {
  throw new Error("string message content failed");
}
if (textContent({ content: { type: "text", text: "object text" } }) !== "object text") {
  throw new Error("object message content failed");
}
const compacted = compactToolContent("tool output");
if (!Array.isArray(compacted.content) || compacted.content[0] !== "tool output") {
  throw new Error("string tool content failed");
}
const summary = messageContentSummary({ content: "summary text" });
if (!Array.isArray(summary) || summary[0]?.type !== "string") {
  throw new Error("string message summary failed");
}
"#);
    fs::write(&path, script).unwrap();
    let output = Command::new("node").arg(&path).output().unwrap();
    let _ = fs::remove_file(&path);
    assert!(
      output.status.success(),
      "stdout: {}\nstderr: {}",
      String::from_utf8_lossy(&output.stdout),
      String::from_utf8_lossy(&output.stderr)
    );
  }
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

fn config_background_idle_stop_minutes(value: Option<&serde_json::Value>) -> Option<u64> {
  value
    .and_then(|v| v.get("piSession"))
    .and_then(|pi_session| pi_session.get("backgroundIdleStopMinutes"))
    .and_then(|minutes| minutes.as_u64())
}

fn config_u64(value: Option<&serde_json::Value>, section: &str, key: &str, allow_zero: bool) -> Option<u64> {
  value
    .and_then(|v| v.get(section))
    .and_then(|section| section.get(key))
    .and_then(|raw| raw.as_u64())
    .filter(|raw| if allow_zero { true } else { *raw > 0 })
}

fn config_storage_event_mode(value: Option<&serde_json::Value>) -> Option<String> {
  value
    .and_then(|v| v.get("storage"))
    .and_then(|storage| storage.get("eventMode"))
    .and_then(|mode| mode.as_str())
    .map(str::trim)
    .filter(|mode| matches!(*mode, "compact" | "full" | "off"))
    .map(ToString::to_string)
}

fn config_usize(value: Option<&serde_json::Value>, section: &str, key: &str) -> Option<usize> {
  value
    .and_then(|v| v.get(section))
    .and_then(|section| section.get(key))
    .and_then(|raw| raw.as_u64())
    .filter(|raw| *raw > 0)
    .and_then(|raw| usize::try_from(raw).ok())
}

fn apply_storage_config(value: Option<&serde_json::Value>, config: &mut StorageConfig) {
  if let Some(limit) = config_u64(value, "storage", "eventTextLimit", false) {
    config.event_text_limit = limit;
  }
  if let Some(limit) = config_u64(value, "storage", "toolResultTextLimit", false) {
    config.tool_result_text_limit = limit;
  }
  if let Some(limit) = config_u64(value, "storage", "projectEventMaxBytes", true) {
    config.project_event_max_bytes = limit;
  }
  if let Some(limit) = config_u64(value, "storage", "terminalLogMaxBytes", true) {
    config.terminal_log_max_bytes = limit;
  }
  if let Some(mode) = config_storage_event_mode(value) {
    config.event_mode = mode;
  }
}

fn resolve_storage_config(workdir: Option<&Path>) -> Result<StorageConfig, String> {
  let (global_path, project_path) = ensure_pi_ide_config_files(workdir, None)?;
  let global_config = read_json_value(&global_path)?;
  let project_config = match &project_path {
    Some(path) => read_json_value(path)?,
    None => None,
  };
  let mut config = StorageConfig {
    event_text_limit: DEFAULT_EVENT_TEXT_LIMIT,
    tool_result_text_limit: DEFAULT_TOOL_RESULT_TEXT_LIMIT,
    project_event_max_bytes: DEFAULT_PROJECT_EVENT_MAX_BYTES,
    terminal_log_max_bytes: DEFAULT_TERMINAL_LOG_MAX_BYTES,
    event_mode: "compact".to_string(),
  };
  apply_storage_config(global_config.as_ref(), &mut config);
  apply_storage_config(project_config.as_ref(), &mut config);
  Ok(config)
}

fn apply_directory_tree_config(value: Option<&serde_json::Value>, config: &mut DirectoryTreeConfig) {
  if let Some(initial_depth) = config_usize(value, "directoryTree", "initialDepth") {
    config.initial_depth = initial_depth;
  }
  if let Some(max_entries) = config_usize(value, "directoryTree", "maxEntriesPerDirectory") {
    config.max_entries_per_directory = max_entries;
  }
  if let Some(preview_max_depth) = config_usize(value, "directoryTree", "previewMaxDepth") {
    config.preview_max_depth = preview_max_depth;
  }
  if let Some(preview_max_lines) = config_usize(value, "directoryTree", "previewMaxLines") {
    config.preview_max_lines = preview_max_lines;
  }
}

fn resolve_directory_tree_config(workdir: Option<&Path>) -> Result<DirectoryTreeConfig, String> {
  let (global_path, project_path) = ensure_pi_ide_config_files(workdir, None)?;
  let global_config = read_json_value(&global_path)?;
  let project_config = match &project_path {
    Some(path) => read_json_value(path)?,
    None => None,
  };
  let mut config = DirectoryTreeConfig {
    initial_depth: DEFAULT_DIRECTORY_TREE_INITIAL_DEPTH,
    max_entries_per_directory: DEFAULT_DIRECTORY_TREE_MAX_ENTRIES_PER_DIRECTORY,
    preview_max_depth: DEFAULT_DIRECTORY_TREE_PREVIEW_MAX_DEPTH,
    preview_max_lines: DEFAULT_DIRECTORY_TREE_PREVIEW_MAX_LINES,
  };
  apply_directory_tree_config(global_config.as_ref(), &mut config);
  apply_directory_tree_config(project_config.as_ref(), &mut config);
  Ok(config)
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
  let background_idle_stop_minutes = config_background_idle_stop_minutes(project_config.as_ref())
    .or_else(|| config_background_idle_stop_minutes(global_config.as_ref()))
    .unwrap_or(DEFAULT_BACKGROUND_PI_IDLE_STOP_MINUTES);
  let mut storage_config = StorageConfig {
    event_text_limit: DEFAULT_EVENT_TEXT_LIMIT,
    tool_result_text_limit: DEFAULT_TOOL_RESULT_TEXT_LIMIT,
    project_event_max_bytes: DEFAULT_PROJECT_EVENT_MAX_BYTES,
    terminal_log_max_bytes: DEFAULT_TERMINAL_LOG_MAX_BYTES,
    event_mode: "compact".to_string(),
  };
  apply_storage_config(global_config.as_ref(), &mut storage_config);
  apply_storage_config(project_config.as_ref(), &mut storage_config);
  Ok(serde_json::json!({
    "debugEnabled": debug_enabled,
    "backgroundIdleStopMinutes": background_idle_stop_minutes,
    "storage": {
      "eventMode": storage_config.event_mode,
      "eventTextLimit": storage_config.event_text_limit,
      "toolResultTextLimit": storage_config.tool_result_text_limit,
      "projectEventMaxBytes": storage_config.project_event_max_bytes,
      "terminalLogMaxBytes": storage_config.terminal_log_max_bytes
    },
    "globalConfig": global_path.to_string_lossy(),
    "projectConfig": project_path.map(|path| path.to_string_lossy().to_string())
  }))
}

fn json_string(value: Option<&serde_json::Value>, key: &str) -> Option<String> {
  value
    .and_then(|v| v.get(key))
    .and_then(|raw| raw.as_str())
    .map(str::trim)
    .filter(|text| !text.is_empty())
    .map(ToString::to_string)
}

fn pi_model_value(provider: &str, id: &str, name: Option<&str>, api: Option<&str>, source: &str) -> serde_json::Value {
  serde_json::json!({
    "provider": provider,
    "id": id,
    "name": name.map(str::trim).filter(|value| !value.is_empty()).unwrap_or(id),
    "api": api.map(str::trim).filter(|value| !value.is_empty()).unwrap_or(""),
    "source": source
  })
}

fn push_pi_model(models: &mut Vec<serde_json::Value>, seen: &mut std::collections::HashSet<String>, provider: &str, id: &str, name: Option<&str>, api: Option<&str>, source: &str) {
  let provider = provider.trim();
  let id = id.trim();
  if id.is_empty() {
    return;
  }
  let key = format!("{provider}:{id}");
  if seen.insert(key) {
    models.push(pi_model_value(provider, id, name, api, source));
  }
}

fn collect_configured_models(models_config: Option<&serde_json::Value>, models: &mut Vec<serde_json::Value>, seen: &mut std::collections::HashSet<String>) {
  let Some(providers) = models_config
    .and_then(|value| value.get("providers"))
    .and_then(|value| value.as_object())
  else {
    return;
  };

  for (provider, config) in providers {
    let provider_api = json_string(Some(config), "api");
    if let Some(list) = config.get("models").and_then(|value| value.as_array()) {
      for model in list {
        if let Some(id) = model.as_str().map(str::trim).filter(|value| !value.is_empty()) {
          push_pi_model(models, seen, provider, id, None, provider_api.as_deref(), "models.json");
        } else if let Some(id) = json_string(Some(model), "id") {
          let name = json_string(Some(model), "name");
          let api = json_string(Some(model), "api").or_else(|| provider_api.clone());
          push_pi_model(models, seen, provider, &id, name.as_deref(), api.as_deref(), "models.json");
        }
      }
    }

    if let Some(overrides) = config.get("modelOverrides").and_then(|value| value.as_object()) {
      for (id, model) in overrides {
        let name = json_string(Some(model), "name");
        let api = json_string(Some(model), "api").or_else(|| provider_api.clone());
        push_pi_model(models, seen, provider, id, name.as_deref(), api.as_deref(), "models.json");
      }
    }
  }
}

#[tauri::command]
fn load_pi_model_config(workdir: Option<String>) -> Result<serde_json::Value, String> {
  let workdir_path = workdir
    .as_deref()
    .map(str::trim)
    .filter(|s| !s.is_empty())
    .map(PathBuf::from);
  let global_settings_path = global_pi_settings_path()?;
  let global_models_path = global_pi_models_path()?;
  let project_settings_path = workdir_path
    .as_deref()
    .filter(|path| path.exists() && path.is_dir())
    .map(project_pi_settings_path);

  let global_settings = read_json_value(&global_settings_path)?;
  let project_settings = match &project_settings_path {
    Some(path) => read_json_value(path)?,
    None => None,
  };
  let models_config = read_json_value(&global_models_path)?;

  let default_provider = json_string(project_settings.as_ref(), "defaultProvider")
    .or_else(|| json_string(global_settings.as_ref(), "defaultProvider"));
  let default_model = json_string(project_settings.as_ref(), "defaultModel")
    .or_else(|| json_string(global_settings.as_ref(), "defaultModel"));

  let mut models = Vec::new();
  let mut seen = std::collections::HashSet::new();
  collect_configured_models(models_config.as_ref(), &mut models, &mut seen);
  if let Some(id) = default_model.as_deref() {
    push_pi_model(&mut models, &mut seen, default_provider.as_deref().unwrap_or(""), id, None, None, "settings.json");
  }

  Ok(serde_json::json!({
    "models": models,
    "defaultModel": default_model.map(|id| pi_model_value(default_provider.as_deref().unwrap_or(""), &id, None, None, "settings.json")),
    "globalSettings": global_settings_path.to_string_lossy(),
    "projectSettings": project_settings_path.map(|path| path.to_string_lossy().to_string()),
    "modelsConfig": global_models_path.to_string_lossy()
  }))
}

fn json_file_has_content(path: &Path) -> bool {
  let Ok(Some(value)) = read_json_value(path) else {
    return false;
  };
  match value {
    serde_json::Value::Null => false,
    serde_json::Value::Object(map) => !map.is_empty(),
    serde_json::Value::Array(list) => !list.is_empty(),
    serde_json::Value::String(text) => !text.trim().is_empty(),
    _ => true,
  }
}

#[cfg(windows)]
fn is_windows_batch_command(path: &Path) -> bool {
  path.extension()
    .and_then(|value| value.to_str())
    .map(|value| matches!(value.to_ascii_lowercase().as_str(), "cmd" | "bat"))
    .unwrap_or(false)
}

#[cfg(windows)]
fn quote_windows_cmd_arg(value: &str) -> String {
  if value.chars().all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.' | ':' | '\\' | '/' | '@')) {
    return value.to_string();
  }
  format!("\"{}\"", value.replace('"', "\\\""))
}

#[cfg(windows)]
fn build_process_command(raw: &str, extra_args: &[&str], envs: &HashMap<String, String>) -> Result<Command, String> {
  let raw = raw.trim();
  if raw.is_empty() {
    return Err("Pi 命令为空".to_string());
  }
  let parts = split_windows_command_line(raw);
  let (program, args) = parts.split_first().ok_or("Pi 命令为空")?;
  let resolved_program = if program.eq_ignore_ascii_case("pi") {
    find_windows_pi_command().unwrap_or_else(|| PathBuf::from(program))
  } else {
    PathBuf::from(program)
  };

  let mut command = if is_pi_wrapper(&resolved_program) {
    if let Some(cli_js) = pi_cli_js_from_wrapper(&resolved_program) {
      let node = find_windows_node_command().unwrap_or_else(|| PathBuf::from("node.exe"));
      let mut command = Command::new(node);
      command.arg(cli_js);
      command.args(args);
      command.args(extra_args);
      command
    } else {
      let mut shell_args = vec![quote_windows_cmd_arg(&resolved_program.to_string_lossy())];
      shell_args.extend(args.iter().map(|value| quote_windows_cmd_arg(value)));
      shell_args.extend(extra_args.iter().map(|value| quote_windows_cmd_arg(value)));
      let mut command = Command::new("cmd.exe");
      command.arg("/D").arg("/C").arg(shell_args.join(" "));
      command
    }
  } else if is_windows_batch_command(&resolved_program) {
    let mut shell_args = vec![quote_windows_cmd_arg(&resolved_program.to_string_lossy())];
    shell_args.extend(args.iter().map(|value| quote_windows_cmd_arg(value)));
    shell_args.extend(extra_args.iter().map(|value| quote_windows_cmd_arg(value)));
    let mut command = Command::new("cmd.exe");
    command.arg("/D").arg("/C").arg(shell_args.join(" "));
    command
  } else {
    let mut command = Command::new(&resolved_program);
    command.args(args);
    command.args(extra_args);
    command
  };

  if let Some(path) = windows_augmented_path() {
    command.env("PATH", path);
  }
  for (key, value) in envs {
    command.env(key, value);
  }
  Ok(command)
}

#[cfg(not(windows))]
fn build_process_command(raw: &str, extra_args: &[&str], envs: &HashMap<String, String>) -> Result<Command, String> {
  let parts = shell_words::split(raw).map_err(|e| format!("Pi 命令解析失败: {e}"))?;
  let (program, args) = parts.split_first().ok_or("Pi 命令为空")?;
  let mut command = Command::new(program);
  command.args(args);
  command.args(extra_args);
  for (key, value) in envs {
    command.env(key, value);
  }
  Ok(command)
}

fn check_pi_version(command_text: &str, envs: &HashMap<String, String>) -> (bool, Option<String>, Option<String>) {
  let mut command = match build_process_command(command_text, &["--version"], envs) {
    Ok(command) => command,
    Err(error) => return (false, None, Some(error)),
  };
  match command.output() {
    Ok(output) if output.status.success() => {
      let stdout = String::from_utf8_lossy(&output.stdout);
      let stderr = String::from_utf8_lossy(&output.stderr);
      let text = stdout.lines().chain(stderr.lines()).find(|line| !line.trim().is_empty()).unwrap_or("").trim().to_string();
      (true, (!text.is_empty()).then_some(text), None)
    }
    Ok(output) => {
      let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
      let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
      let detail = if !stderr.is_empty() { stderr } else { stdout };
      (false, None, Some(if detail.is_empty() { format!("Pi 命令退出码：{}", output.status) } else { detail }))
    }
    Err(error) => (false, None, Some(format!("执行 Pi 命令失败：{error}"))),
  }
}

#[tauri::command]
fn check_pi_environment(workdir: Option<String>, legacy_command: Option<String>) -> Result<serde_json::Value, String> {
  let workdir_path = workdir
    .as_deref()
    .map(str::trim)
    .filter(|s| !s.is_empty())
    .map(PathBuf::from);
  let (command_text, envs, config_info) = resolve_pi_launch_config(workdir_path.as_deref(), legacy_command.as_deref())?;
  let (installed, version, command_error) = check_pi_version(&command_text, &envs);

  let auth_path = global_pi_auth_path()?;
  let has_auth = json_file_has_content(&auth_path);
  let model_config = load_pi_model_config(workdir.clone()).unwrap_or_else(|error| {
    serde_json::json!({
      "models": [],
      "defaultModel": serde_json::Value::Null,
      "error": error
    })
  });
  let model_count = model_config
    .get("models")
    .and_then(|value| value.as_array())
    .map(|list| list.len())
    .unwrap_or(0);
  let has_default_model = model_config.get("defaultModel").is_some_and(|value| !value.is_null());
  let has_models = model_count > 0 || has_default_model;

  let mut issues = Vec::new();
  if !installed {
    issues.push(serde_json::json!({
      "code": "PI_NOT_INSTALLED",
      "message": command_error.clone().unwrap_or_else(|| "未找到可用 Pi 命令".to_string())
    }));
  }
  if !has_models && !has_auth {
    issues.push(serde_json::json!({
      "code": "PI_MODEL_NOT_CONFIGURED",
      "message": "未发现模型配置或已有认证信息"
    }));
  }

  Ok(serde_json::json!({
    "ready": installed && (has_models || has_auth),
    "installed": installed,
    "command": command_text,
    "version": version,
    "hasModels": has_models,
    "modelCount": model_count,
    "hasDefaultModel": has_default_model,
    "hasAuth": has_auth,
    "issues": issues,
    "config": config_info,
    "modelsConfig": model_config.get("modelsConfig").cloned().unwrap_or(serde_json::Value::Null),
    "globalSettings": model_config.get("globalSettings").cloned().unwrap_or(serde_json::Value::Null),
    "projectSettings": model_config.get("projectSettings").cloned().unwrap_or(serde_json::Value::Null),
    "authConfig": auth_path.to_string_lossy()
  }))
}

fn upsert_model(models: &mut Vec<serde_json::Value>, model_id: &str, model_name: Option<&str>) {
  let next_model = if let Some(name) = model_name.map(str::trim).filter(|value| !value.is_empty()) {
    serde_json::json!({ "id": model_id, "name": name })
  } else {
    serde_json::json!({ "id": model_id })
  };
  for model in models.iter_mut() {
    let existing_id = model
      .as_str()
      .map(str::trim)
      .filter(|value| !value.is_empty())
      .map(ToString::to_string)
      .or_else(|| json_string(Some(model), "id"));
    if existing_id.as_deref() == Some(model_id) {
      *model = next_model;
      return;
    }
  }
  models.push(next_model);
}

fn update_default_model_settings(path: &Path, provider: &str, model_id: &str) -> Result<(), String> {
  let mut value = read_json_value(path)?.unwrap_or_else(|| serde_json::json!({}));
  if !value.is_object() {
    value = serde_json::json!({});
  }
  if let Some(map) = value.as_object_mut() {
    map.insert("defaultProvider".to_string(), serde_json::Value::String(provider.to_string()));
    map.insert("defaultModel".to_string(), serde_json::Value::String(model_id.to_string()));
  }
  write_json_value(path, &value)
}

#[tauri::command]
fn save_pi_model_template(
  workdir: Option<String>,
  template: String,
  provider: String,
  model_id: String,
  model_name: Option<String>,
  base_url: Option<String>,
  api_key: Option<String>,
  api: Option<String>,
) -> Result<serde_json::Value, String> {
  let provider = provider.trim();
  let model_id = model_id.trim();
  if provider.is_empty() {
    return Err("Provider 不能为空".to_string());
  }
  if model_id.is_empty() {
    return Err("模型 ID 不能为空".to_string());
  }

  let models_path = global_pi_models_path()?;
  let mut value = read_json_value(&models_path)?.unwrap_or_else(|| serde_json::json!({ "providers": {} }));
  if !value.is_object() {
    value = serde_json::json!({ "providers": {} });
  }
  let root = value.as_object_mut().ok_or("模型配置格式无效")?;
  if !matches!(root.get("providers"), Some(value) if value.is_object()) {
    root.insert("providers".to_string(), serde_json::json!({}));
  }
  let providers = root.get_mut("providers").and_then(|value| value.as_object_mut()).ok_or("模型 Provider 配置格式无效")?;
  if !matches!(providers.get(provider), Some(value) if value.is_object()) {
    providers.insert(provider.to_string(), serde_json::json!({}));
  }
  let provider_config = providers.get_mut(provider).and_then(|value| value.as_object_mut()).ok_or("模型 Provider 配置格式无效")?;

  if let Some(value) = base_url.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
    provider_config.insert("baseUrl".to_string(), serde_json::Value::String(value.to_string()));
  }
  if let Some(value) = api.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
    provider_config.insert("api".to_string(), serde_json::Value::String(value.to_string()));
  }
  if let Some(value) = api_key.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
    provider_config.insert("apiKey".to_string(), serde_json::Value::String(value.to_string()));
  }
  if template.trim() == "ollama" {
    provider_config.insert("compat".to_string(), serde_json::json!({
      "supportsDeveloperRole": false,
      "supportsReasoningEffort": false
    }));
  }

  let mut models = provider_config
    .remove("models")
    .and_then(|value| value.as_array().cloned())
    .unwrap_or_default();
  upsert_model(&mut models, model_id, model_name.as_deref());
  provider_config.insert("models".to_string(), serde_json::Value::Array(models));
  write_json_value(&models_path, &value)?;

  let workdir_path = workdir
    .as_deref()
    .map(str::trim)
    .filter(|s| !s.is_empty())
    .map(PathBuf::from);
  update_default_model_settings(&global_pi_settings_path()?, provider, model_id)?;
  if let Some(path) = workdir_path.as_deref().filter(|path| path.exists() && path.is_dir()).map(project_pi_settings_path) {
    update_default_model_settings(&path, provider, model_id)?;
  }

  load_pi_model_config(workdir)
}

#[tauri::command]
async fn install_pi_cli() -> Result<serde_json::Value, String> {
  tauri::async_runtime::spawn_blocking(|| {
    #[cfg(windows)]
    let mut command = {
      let mut command = Command::new("cmd.exe");
      command.arg("/D").arg("/C").arg("npm install -g @earendil-works/pi-coding-agent");
      if let Some(path) = windows_augmented_path() {
        command.env("PATH", path);
      }
      command
    };

    #[cfg(not(windows))]
    let mut command = {
      let mut command = Command::new("npm");
      command.args(["install", "-g", "@earendil-works/pi-coding-agent"]);
      command
    };

    let output = command.output().map_err(|e| format!("启动 npm 安装失败：{e}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if !output.status.success() {
      return Err(if stderr.is_empty() { format!("npm 安装失败：{}", output.status) } else { stderr });
    }
    Ok(serde_json::json!({
      "success": true,
      "stdout": stdout,
      "stderr": stderr
    }))
  }).await.map_err(|e| format!("安装任务失败：{e}"))?
}

const PI_IDE_BRIDGE_EXTENSION: &str = r#"import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

const bashBefore = new Map();
let sequence = 0;

function eventTextLimit() {
  const value = Number(process.env.PI_IDE_EVENT_TEXT_LIMIT || "51200");
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 51200;
}

function eventMode() {
  const value = String(process.env.PI_IDE_EVENT_MODE || "compact").trim();
  return ["compact", "full", "off"].includes(value) ? value : "compact";
}

function shouldPersistTimelineEvent(eventType) {
  const mode = eventMode();
  if (mode === "full") return true;
  if (mode === "off") return false;
  return eventType !== "message_update" && eventType !== "tool_execution_update";
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
  return positiveEnvNumber("PI_IDE_TOOL_RESULT_TEXT_LIMIT", 51200);
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
  const next = contentItems(content).map((item) => {
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
  return contentItems(message).map((item) => {
    if (typeof item === "string") return item;
    if (item?.type === "text") return item.text || "";
    return "";
  }).filter(Boolean).join("");
}

function contentItems(value) {
  const raw = value && typeof value === "object" && "content" in value ? value.content : value;
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "string") return [raw];
  if (raw && typeof raw === "object") return [raw];
  return [];
}

function contentItemText(item) {
  if (typeof item === "string") return item;
  if (!item || typeof item !== "object") return "";
  return String(item.text || item.content || "");
}

function contentBlockText(value, index) {
  const content = contentItems(value);
  const item = Number.isInteger(index) ? content[index] : undefined;
  if (item !== undefined) return contentItemText(item);
  return content.map(contentItemText).filter(Boolean).join("");
}

function contentBlockType(value, index) {
  const content = contentItems(value);
  const item = Number.isInteger(index) ? content[index] : undefined;
  if (typeof item === "string") return "string";
  if (item && typeof item === "object") return item.type || "";
  return "";
}

function previewText(value, limit = 180) {
  const text = String(value || "");
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function contentItemSummary(item, index) {
  if (typeof item === "string") {
    return { index, type: "string", textLength: item.length, preview: previewText(item) };
  }
  if (!item || typeof item !== "object") {
    return { index, type: typeof item };
  }
  const text = String(item.text || item.content || "");
  const summary = {
    index,
    type: item.type || "",
    textLength: text.length,
    preview: previewText(text),
  };
  if (item.name) summary.name = item.name;
  if (item.id) summary.id = item.id;
  if (item.toolName) summary.toolName = item.toolName;
  return summary;
}

function messageContentSummary(message) {
  return contentItems(message).map(contentItemSummary);
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
  if (!shouldPersistTimelineEvent(eventType)) return;
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
      messageContentSummary: messageContentSummary(event.message),
      toolResults: event.toolResults?.map(compactResult) || [],
    });
  });

  pi.on("message_update", async (event, ctx) => {
    const delta = event.assistantMessageEvent || {};
    const rawContentIndex = Number(delta.contentIndex);
    const contentIndex = Number.isInteger(rawContentIndex) ? rawContentIndex : undefined;
    appendTimeline(ctx, event.type, {
      messageId: event.message?.id,
      messageRole: event.message?.role,
      deltaType: delta.type,
      contentIndex,
      delta: limitText(delta.delta || ""),
      content: limitText(delta.content || ""),
      reason: limitText(delta.reason || ""),
      blockType: contentBlockType(event.message, contentIndex),
      blockText: limitText(contentBlockText(event.message, contentIndex)),
      partialBlockType: contentBlockType(delta.partial, contentIndex),
      partialBlockText: limitText(contentBlockText(delta.partial, contentIndex)),
      deltaPreview: previewText(delta.delta || ""),
      contentPreview: previewText(delta.content || ""),
      reasonPreview: previewText(delta.reason || ""),
      messageContentSummary: messageContentSummary(event.message),
      partialContentSummary: messageContentSummary(delta.partial),
    });
  });

  pi.on("message_end", async (event, ctx) => {
    appendTimeline(ctx, event.type, {
      messageId: event.message?.id,
      text: limitText(textContent(event.message)),
      messageRole: event.message?.role,
      messageContentSummary: messageContentSummary(event.message),
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

fn clear_file_if_oversized(path: &Path, max_bytes: u64) -> Result<(), String> {
  if !path.exists() {
    return Ok(());
  }
  let len = fs::metadata(path).map_err(|e| format!("读取事件文件大小失败 {:?}: {e}", path))?.len();
  if len > max_bytes {
    fs::write(path, "").map_err(|e| format!("清理过大事件文件失败 {:?}: {e}", path))?;
  }
  Ok(())
}

fn clear_cache_file(items: &mut Vec<serde_json::Value>, path: &Path, kind: &str) -> Result<(), String> {
  if !path.exists() || !path.is_file() {
    return Ok(());
  }
  let before = fs::metadata(path).map_err(|e| format!("读取缓存文件大小失败 {:?}: {e}", path))?.len();
  if before == 0 {
    return Ok(());
  }
  fs::write(path, b"").map_err(|e| format!("清理缓存文件失败 {:?}: {e}", path))?;
  let after = fs::metadata(path).map_err(|e| format!("读取清理后缓存文件大小失败 {:?}: {e}", path))?.len();
  items.push(serde_json::json!({
    "kind": kind,
    "path": path.to_string_lossy(),
    "beforeBytes": before,
    "afterBytes": after,
    "freedBytes": before.saturating_sub(after)
  }));
  Ok(())
}

fn clear_project_cache_files(workdir: &str, items: &mut Vec<serde_json::Value>, skipped: &mut Vec<serde_json::Value>) -> Result<(), String> {
  let text = workdir.trim();
  if text.is_empty() {
    return Ok(());
  }
  let dir = PathBuf::from(text);
  if !dir.exists() || !dir.is_dir() {
    skipped.push(serde_json::json!({
      "path": text,
      "reason": "项目目录不存在"
    }));
    return Ok(());
  }
  clear_cache_file(items, &pi_ide_events_path(&dir), "project-events")?;
  clear_cache_file(items, &pi_ide_file_events_path(&dir), "project-file-events")?;
  Ok(())
}

fn clear_terminal_cache_logs(dir: &Path, items: &mut Vec<serde_json::Value>) -> Result<(), String> {
  if !dir.exists() {
    return Ok(());
  }
  for entry in fs::read_dir(dir).map_err(|e| format!("读取会话缓存目录失败 {:?}: {e}", dir))? {
    let path = entry.map_err(|e| format!("读取会话缓存项失败 {:?}: {e}", dir))?.path();
    if path.is_dir() {
      clear_terminal_cache_logs(&path, items)?;
    } else if path.file_name().and_then(|name| name.to_str()) == Some("terminal.log") {
      clear_cache_file(items, &path, "terminal-log")?;
    }
  }
  Ok(())
}

fn ensure_pi_ide_file_tracker(workdir: &Path, project_event_max_bytes: u64) -> Result<(), String> {
  let pi_dir = workdir.join(".pi");
  let extensions_dir = pi_dir.join("extensions");
  fs::create_dir_all(&extensions_dir).map_err(|e| format!("创建 Pi IDE 扩展目录失败: {e}"))?;
  fs::write(extensions_dir.join("pi-ide-file-tracker.ts"), PI_IDE_BRIDGE_EXTENSION)
    .map_err(|e| format!("写入 Pi IDE 事件桥扩展失败: {e}"))?;
  let events_path = pi_ide_events_path(workdir);
  if !events_path.exists() {
    fs::write(&events_path, "").map_err(|e| format!("初始化 Pi IDE 事件流失败: {e}"))?;
  }
  clear_file_if_oversized(&events_path, project_event_max_bytes)?;
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

fn sort_directory_entries(entries: &mut [fs::DirEntry]) {
  entries.sort_by(|a, b| {
    let a_is_dir = a.file_type().map(|t| t.is_dir()).unwrap_or(false);
    let b_is_dir = b.file_type().map(|t| t.is_dir()).unwrap_or(false);
    b_is_dir
      .cmp(&a_is_dir)
      .then_with(|| a.file_name().to_string_lossy().to_lowercase().cmp(&b.file_name().to_string_lossy().to_lowercase()))
  });
}

fn limited_sorted_directory_entries(dir: &Path, max_entries: usize) -> Result<(Vec<fs::DirEntry>, bool), String> {
  let mut entries = Vec::new();
  let mut truncated = false;
  for entry in fs::read_dir(dir).map_err(|e| format!("读取目录失败 {:?}: {e}", dir))? {
    if entries.len() >= max_entries {
      truncated = true;
      break;
    }
    if let Ok(entry) = entry {
      entries.push(entry);
    }
  }
  sort_directory_entries(&mut entries);
  Ok((entries, truncated))
}

fn build_directory_tree_node(
  path: &Path,
  name: String,
  depth: usize,
  max_depth: usize,
  max_entries_per_directory: usize,
  truncated: &mut bool,
) -> Result<DirectoryTreeNode, String> {
  let is_dir = path.is_dir();
  let mut node = DirectoryTreeNode {
    name,
    path: path.to_string_lossy().to_string(),
    is_dir,
    omitted: false,
    children_loaded: !is_dir,
    has_more: false,
    children: vec![],
  };

  if !is_dir {
    return Ok(node);
  }

  if depth >= max_depth {
    node.children_loaded = false;
    node.has_more = true;
    return Ok(node);
  }

  node.children_loaded = true;
  let (entries, entries_truncated) = limited_sorted_directory_entries(path, max_entries_per_directory)?;
  if entries_truncated {
    node.has_more = true;
    *truncated = true;
  }

  for entry in entries {
    let child_path = entry.path();
    let child_name = entry.file_name().to_string_lossy().to_string();
    let file_type = entry.file_type().map_err(|e| format!("读取文件类型失败 {:?}: {e}", child_path))?;

    if file_type.is_dir() && should_omit_dir(&child_name) {
      node.children.push(DirectoryTreeNode {
        name: child_name,
        path: child_path.to_string_lossy().to_string(),
        is_dir: true,
        omitted: true,
        children_loaded: true,
        has_more: false,
        children: vec![],
      });
    } else {
      node.children.push(build_directory_tree_node(
        &child_path,
        child_name,
        depth + 1,
        max_depth,
        max_entries_per_directory,
        truncated,
      )?);
    }
  }

  if entries_truncated {
    node.children.push(DirectoryTreeNode {
      name: "… 已省略更多条目".to_string(),
      path: path.to_string_lossy().to_string(),
      is_dir: false,
      omitted: true,
      children_loaded: true,
      has_more: false,
      children: vec![],
    });
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
  let config = resolve_directory_tree_config(Some(&root))?;
  // 首次打开目录树时只返回根节点，不预扫描子目录。
  // 子目录内容统一在用户点击展开目录时通过 get_directory_children 按需加载，
  // 避免打开项目或切换项目时因为大目录遍历造成 UI 卡顿。
  let lines = vec![format!("{}/", root_name)];
  let lines_truncated = false;

  let mut tree_truncated = false;
  let tree = build_directory_tree_node(
    &root,
    root_name,
    0,
    0,
    config.max_entries_per_directory,
    &mut tree_truncated,
  )?;

  Ok(DirectoryTreeResponse {
    root: root.to_string_lossy().to_string(),
    lines,
    tree,
    truncated: lines_truncated || tree_truncated,
  })
}

#[tauri::command]
fn get_directory_children(project_root: String, path: String) -> Result<DirectoryTreeChildrenResponse, String> {
  let root = PathBuf::from(project_root.trim());
  let target = PathBuf::from(path.trim());
  if !root.exists() || !root.is_dir() {
    return Err(format!("项目目录不存在：{}", root.to_string_lossy()));
  }
  if !target.exists() || !target.is_dir() {
    return Err(format!("目录不存在：{}", target.to_string_lossy()));
  }

  let canonical_root = root.canonicalize().map_err(|e| format!("解析项目目录失败 {:?}: {e}", root))?;
  let canonical_target = target.canonicalize().map_err(|e| format!("解析目录失败 {:?}: {e}", target))?;
  if !canonical_target.starts_with(&canonical_root) {
    return Err(format!("目录不在当前项目内：{}", target.to_string_lossy()));
  }

  let config = resolve_directory_tree_config(Some(&root))?;
  let name = target
    .file_name()
    .and_then(|name| name.to_str())
    .unwrap_or("目录")
    .to_string();
  let mut truncated = false;
  let node = build_directory_tree_node(
    &target,
    name,
    0,
    1,
    config.max_entries_per_directory,
    &mut truncated,
  )?;

  Ok(DirectoryTreeChildrenResponse {
    path: target.to_string_lossy().to_string(),
    children: node.children,
    truncated: node.has_more || truncated,
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
  let npm_root = wrapper.parent()?.join("node_modules");
  for package_path in [
    npm_root.join("@earendil-works").join("pi-coding-agent"),
    npm_root.join("@mariozechner").join("pi-coding-agent"),
  ] {
    let cli = package_path.join("dist").join("cli.js");
    if cli.exists() {
      return Some(cli);
    }
  }
  None
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

fn terminal_log_max_bytes() -> u64 {
  std::env::var("PI_IDE_TERMINAL_LOG_MAX_BYTES")
    .ok()
    .and_then(|value| value.trim().parse::<u64>().ok())
    .unwrap_or(DEFAULT_TERMINAL_LOG_MAX_BYTES)
}

fn terminal_log_path(session_id: &str) -> Result<PathBuf, String> {
  Ok(session_dir(session_id)?.join("terminal.log"))
}

fn trim_file_to_tail(path: &Path, max_bytes: u64) -> Result<(), String> {
  if max_bytes == 0 || !path.exists() {
    return Ok(());
  }
  let len = fs::metadata(path).map_err(|e| format!("读取文件大小失败 {:?}: {e}", path))?.len();
  if len <= max_bytes {
    return Ok(());
  }
  let mut file = fs::File::open(path).map_err(|e| format!("打开文件失败 {:?}: {e}", path))?;
  file.seek(SeekFrom::Start(len - max_bytes))
    .map_err(|e| format!("定位文件尾部失败 {:?}: {e}", path))?;
  let mut bytes = Vec::new();
  file.read_to_end(&mut bytes).map_err(|e| format!("读取文件尾部失败 {:?}: {e}", path))?;
  fs::write(path, bytes).map_err(|e| format!("裁剪文件失败 {:?}: {e}", path))
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

fn append_limited_terminal_log_bytes(path: &Path, data: &[u8], max_bytes: u64) -> Result<(), String> {
  if max_bytes == 0 {
    return Ok(());
  }
  append_terminal_log_bytes(path, data)?;
  trim_file_to_tail(path, max_bytes)
}

#[tauri::command]
fn append_terminal_log(session_id: String, data: String) -> Result<(), String> {
  if session_id.trim().is_empty() || data.is_empty() {
    return Ok(());
  }
  let path = terminal_log_path(&session_id)?;
  append_limited_terminal_log_bytes(&path, data.as_bytes(), terminal_log_max_bytes())
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
  let storage_config = resolve_storage_config(workdir_path.as_deref())?;
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
  cmd.env("PI_IDE_EVENT_MODE", storage_config.event_mode.clone());
  cmd.env("PI_IDE_EVENT_TEXT_LIMIT", storage_config.event_text_limit.to_string());
  cmd.env("PI_IDE_TOOL_RESULT_TEXT_LIMIT", storage_config.tool_result_text_limit.to_string());
  cmd.env("PI_IDE_TERMINAL_LOG_MAX_BYTES", storage_config.terminal_log_max_bytes.to_string());
  for (key, value) in config_envs {
    cmd.env(key, value);
  }

  if let Some(dir_path) = workdir_path.as_ref() {
    ensure_pi_ide_file_tracker(dir_path, storage_config.project_event_max_bytes)?;
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
  let out_terminal_log_max_bytes = storage_config.terminal_log_max_bytes;
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
          let _ = append_limited_terminal_log_bytes(&out_terminal_log_path, &buf[..n], out_terminal_log_max_bytes);
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

#[tauri::command]
fn clean_pi_ide_cache(workdirs: Option<Vec<String>>) -> Result<serde_json::Value, String> {
  let mut items = Vec::new();
  let mut skipped = Vec::new();
  clear_cache_file(&mut items, &debug_log_path()?, "debug-log")?;
  clear_terminal_cache_logs(&storage_dir()?.join("pi-sessions"), &mut items)?;

  let mut seen = std::collections::HashSet::new();
  for workdir in workdirs.unwrap_or_default() {
    let text = workdir.trim();
    if !text.is_empty() && seen.insert(text.to_string()) {
      clear_project_cache_files(text, &mut items, &mut skipped)?;
    }
  }

  if let Ok(mut offsets) = PI_EVENT_OFFSETS.lock() {
    offsets.clear();
  }

  let before_bytes = items.iter().filter_map(|item| item.get("beforeBytes").and_then(|value| value.as_u64())).sum::<u64>();
  let after_bytes = items.iter().filter_map(|item| item.get("afterBytes").and_then(|value| value.as_u64())).sum::<u64>();
  Ok(serde_json::json!({
    "filesCleared": items.len(),
    "beforeBytes": before_bytes,
    "afterBytes": after_bytes,
    "freedBytes": before_bytes.saturating_sub(after_bytes),
    "items": items,
    "skipped": skipped,
    "piAgentSessionsTouched": false
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
      check_pi_environment,
      load_pi_model_config,
      save_pi_model_template,
      install_pi_cli,
      open_path_in_file_manager,
      open_file_with_default_app,
      get_directory_tree,
      get_directory_children,
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
      clean_pi_ide_cache,
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
