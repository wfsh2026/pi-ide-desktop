export function isPointerDragActive(startX, startY, currentX, currentY, threshold = 5) {
  const values = [startX, startY, currentX, currentY, threshold].map(Number);
  if (values.some((value) => !Number.isFinite(value))) return false;
  const [sx, sy, cx, cy, minDistance] = values;
  return Math.hypot(cx - sx, cy - sy) >= Math.max(1, minDistance);
}

export function isComposerDropTarget(target) {
  return Boolean(target?.closest?.(".composer"));
}
