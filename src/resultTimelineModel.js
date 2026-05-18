function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function fileKey(file) {
  return file?.path || file?.name || "";
}

function uniqueFiles(files) {
  const seen = new Set();
  return safeArray(files).filter((file) => {
    const key = fileKey(file);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function commandText(item) {
  return String(item?.command || item?.title || "").trim();
}

function isVerificationCommand(item) {
  if (!item || item.type !== "command") return false;
  const command = commandText(item);
  return /(^|\s)(npm|pnpm|yarn)\s+(run\s+)?(build|test|lint|typecheck)\b/i.test(command)
    || /^node\s+.+\.test\.mjs\b/i.test(command)
    || /^cargo\s+(check|test|clippy)\b/i.test(command)
    || /(^|\s)(vitest|jest|tsc)\b/i.test(command);
}

function verificationStatus(item) {
  if (item.status === "running") return "running";
  if (item.status === "failed") return "failed";
  if (item.exitCode != null && item.exitCode !== 0) return "failed";
  return "passed";
}

function buildVerification(item) {
  return {
    id: item.id || commandText(item),
    command: commandText(item),
    status: verificationStatus(item),
    exitCode: item.exitCode ?? null,
    output: String(item.output || "")
  };
}

function resultStatus(turnStatus, verifications, errors) {
  if (turnStatus === "cancelled") return "cancelled";
  if (turnStatus === "running") return "running";
  if (safeArray(errors).length > 0) return "failed";
  if (verifications.some((item) => item.status === "failed")) return "failed";
  if (verifications.some((item) => item.status === "running")) return "running";
  if (verifications.length > 0) return "verified";
  return "unverified";
}

export function buildResultView({ conclusion = "", processItems = [], outputs = [], errors = [] } = {}, turnStatus = "completed") {
  const verifications = safeArray(processItems)
    .filter(isVerificationCommand)
    .map(buildVerification);
  const files = uniqueFiles(outputs);
  const status = resultStatus(turnStatus, verifications, errors);
  return {
    status,
    conclusion: String(conclusion || "").trim(),
    verifications,
    files,
    errors: safeArray(errors),
    hasContent: Boolean(String(conclusion || "").trim() || verifications.length || files.length || safeArray(errors).length)
  };
}

export function resultStatusLabel(status) {
  if (status === "verified") return "已验证";
  if (status === "failed") return "失败";
  if (status === "cancelled") return "已取消";
  if (status === "running") return "处理中";
  return "未验证";
}

export function verificationSummary(verifications) {
  const list = safeArray(verifications);
  if (list.length === 0) return "未运行验证";
  const failed = list.filter((item) => item.status === "failed").length;
  const running = list.filter((item) => item.status === "running").length;
  const passed = list.filter((item) => item.status === "passed").length;
  const parts = [];
  if (passed) parts.push(`${passed} 通过`);
  if (running) parts.push(`${running} 运行中`);
  if (failed) parts.push(`${failed} 失败`);
  return parts.join(" · ");
}
