import React, { useMemo } from "react";
import { Trash2 } from "lucide-react";

function buildTree(nodes) {
  const map = new Map(nodes.map((n) => [n.id, { ...n, children: [] }]));
  const roots = [];
  for (const node of map.values()) {
    if (node.parent_id && map.has(node.parent_id)) map.get(node.parent_id).children.push(node);
    else roots.push(node);
  }
  return roots;
}

function Node({ node, activeId, onSelect, onDelete, depth = 0 }) {
  return (
    <div>
      <div className={`tree-row ${activeId === node.id ? "active" : ""}`} style={{ paddingLeft: 8 + depth * 14 }}>
        <button className="tree-node" onClick={() => onSelect(node.id)} title={node.command}>
          <span>{node.title}</span>
          <small>{new Date(node.created_at).toLocaleTimeString()}</small>
        </button>
        <button
          className="icon danger tree-delete"
          title="删除该会话及其子会话"
          onClick={(event) => {
            event.stopPropagation();
            onDelete(node.id);
          }}
        >
          <Trash2 size={14} />
        </button>
      </div>
      {node.children.map((child) => (
        <Node key={child.id} node={child} activeId={activeId} onSelect={onSelect} onDelete={onDelete} depth={depth + 1} />
      ))}
    </div>
  );
}

export default function SessionTree({ nodes, activeId, onSelect, onDelete }) {
  const roots = useMemo(() => buildTree(nodes), [nodes]);
  return (
    <div className="scroll-list tree">
      {roots.length === 0 && <div className="empty">暂无会话节点。发送第一条指令后会自动生成。</div>}
      {roots.map((node) => <Node key={node.id} node={node} activeId={activeId} onSelect={onSelect} onDelete={onDelete} />)}
    </div>
  );
}
