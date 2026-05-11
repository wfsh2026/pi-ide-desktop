import React, { useMemo } from "react";

function buildTree(nodes) {
  const map = new Map(nodes.map((n) => [n.id, { ...n, children: [] }]));
  const roots = [];
  for (const node of map.values()) {
    if (node.parent_id && map.has(node.parent_id)) map.get(node.parent_id).children.push(node);
    else roots.push(node);
  }
  return roots;
}

function Node({ node, activeId, onSelect, depth = 0 }) {
  return (
    <div>
      <button className={`tree-node ${activeId === node.id ? "active" : ""}`} style={{ paddingLeft: 8 + depth * 14 }} onClick={() => onSelect(node.id)} title={node.command}>
        <span>{node.title}</span>
        <small>{new Date(node.created_at).toLocaleTimeString()}</small>
      </button>
      {node.children.map((child) => <Node key={child.id} node={child} activeId={activeId} onSelect={onSelect} depth={depth + 1} />)}
    </div>
  );
}

export default function SessionTree({ nodes, activeId, onSelect }) {
  const roots = useMemo(() => buildTree(nodes), [nodes]);
  return (
    <div className="scroll-list tree">
      {roots.length === 0 && <div className="empty">暂无会话节点。发送第一条指令后会自动生成。</div>}
      {roots.map((node) => <Node key={node.id} node={node} activeId={activeId} onSelect={onSelect} />)}
    </div>
  );
}
