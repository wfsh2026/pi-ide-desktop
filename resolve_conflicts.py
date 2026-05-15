import re

with open('src/piIdeEventMapper.js', 'r', encoding='utf-8') as f:
    text = f.read()

# Resolve all 4 conflict regions one by one

# --- Conflict 1: tool_execution_start ---
# HEAD has: let nextItems = upsertProgress(upsertCommand(items, event, { ... })
# feature has: sessionDebug + transferAssistantPreambleToProcess + closeLastThinkingRound + return upsertProgress(upsertCommand(itemsAfterThinking, event, { ... })
# Keep: sessionDebug + transferAssistantPreambleToProcess + closeLastThinkingRound from feature
# Keep: let nextItems = ... from HEAD
# Keep: subagent handling from HEAD

m1_start = "<<<<<<< HEAD\n    let nextItems = upsertProgress(upsertCommand(items, event, {\n=======\n    sessionDebug(\"event\", \"tool_execution_start\", { command, toolName: event.toolName });\n    const itemsAfterNote = transferAssistantPreambleToProcess(items, now, makeId);\n    const itemsAfterThinking = closeLastThinkingRound(itemsAfterNote, now);\n    return upsertProgress(upsertCommand(itemsAfterThinking, event, {\n>>>>>>> feature/session-view-modify\n"
m1_end = "\n    }, now, makeId), toolProgressKey(event), {\n      title: toolTitle(event, false),\n      detail: event.toolName === \"bash\" ? \"\" : command,\n      status: \"running\"\n    }, now, makeId);\n"

# Replace with: sessionDebug + transfer + close + let nextItems = upsertProgress
r1 = "    sessionDebug(\"event\", \"tool_execution_start\", { command, toolName: event.toolName });\n    const itemsAfterNote = transferAssistantPreambleToProcess(items, now, makeId);\n    const itemsAfterThinking = closeLastThinkingRound(itemsAfterNote, now);\n    let nextItems = upsertProgress(upsertCommand(itemsAfterThinking, event, {"
text = text.replace(m1_start + m1_end[1:], r1 + m1_end)

# --- Conflict 2: tool_execution_end ---
m2_start = "<<<<<<< HEAD\n    let nextItems = upsertProgress(upsertCommand(items, commandEvent, {\n=======\n    sessionDebug(\"event\", \"tool_execution_end\", { command: commandText(commandEvent), isError: event.isError, exitCode: exitCode(event) });\n    return upsertProgress(upsertCommand(items, commandEvent, {\n>>>>>>> feature/session-view-modify\n"
m2_body = "      output: resultText(event.result),\n"
r2 = "    sessionDebug(\"event\", \"tool_execution_end\", { command: commandText(commandEvent), isError: event.isError, exitCode: exitCode(event) });\n    let nextItems = upsertProgress(upsertCommand(items, commandEvent, {\n      output: resultText(event.result),"
text = text.replace(m2_start + m2_body, r2 + "\n")

# --- Conflict 3: agent_end (already looks resolved but check) ---
# Just remove any remaining markers around agent_end
text = text.replace("<<<<<<< HEAD\n    return upsertProgress(completeItems(items, \"completed\", now)", "    return upsertProgress(completeItems(items, \"completed\", now)")
text = text.replace("    return upsertProgress(completeItems(items, \"completed\", now), progressKey(event), {\n=======\n>>>>>>> feature/session-view-modify\n", "    return upsertProgress(completeItems(items, \"completed\", now), progressKey(event), {")

# --- Conflict 4: applyPiIdeTimelineEvent entry ---
m4 = "<<<<<<< HEAD\n  if (!event || ![\"timeline\", \"subagent\"].includes(event.kind)) return turns;\n=======\n  if (!event || event.kind !== \"timeline\") return turns;\n  sessionDebug(\"event\", \"incoming\", { eventType: event.eventType || event.type, toolName: event.toolName, deltaType: event.deltaType });\n>>>>>>> feature/session-view-modify"
r4 = "  if (!event || ![\"timeline\", \"subagent\"].includes(event.kind)) return turns;\n  sessionDebug(\"event\", \"incoming\", { eventType: event.eventType || event.type, toolName: event.toolName, deltaType: event.deltaType });"
text = text.replace(m4, r4)

# --- Conflict 5: applyPiIdeTimelineEvent body ---
old_body = "<<<<<<< HEAD\n    const currentItems = Array.isArray(turn.items) ? turn.items : [];\n    return {\n      ...turn,\n      status: finalStatus || turn.status || \"running\",\n      items: event.kind === \"subagent\"\n        ? applySubagentEventToItems(currentItems, event, now, makeId)\n        : applyEventToItems(currentItems, event, now, makeId),\n=======\n    const newItems = applyEventToItems(Array.isArray(turn.items) ? turn.items : [], event, now, makeId);\n    const newTurn = {\n      ...turn,\n      status: finalStatus || turn.status || \"running\",\n      items: newItems,\n>>>>>>> feature/session-view-modify"

new_body = """    const currentItems = Array.isArray(turn.items) ? turn.items : [];
    const newItems = event.kind === "subagent"
      ? applySubagentEventToItems(currentItems, event, now, makeId)
      : applyEventToItems(currentItems, event, now, makeId);
    const newTurn = {
      ...turn,
      status: finalStatus || turn.status || "running",
      items: newItems,"""

text = text.replace(old_body, new_body)

with open('src/piIdeEventMapper.js', 'w', encoding='utf-8') as f:
    f.write(text)

# Verify
remaining = re.findall(r'(<<<<<<< |=======|>>>>>>> )', text)
if remaining:
    print(f"WARNING: {len(remaining)} conflict markers remain!")
else:
    print("All conflicts resolved in piIdeEventMapper.js!")
