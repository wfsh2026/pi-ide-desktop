import React, { useMemo, useState } from "react";

export default function HistoryPanel({ items, onPick }) {
  const [q, setQ] = useState("");
  const filtered = useMemo(() => {
    const query = q.trim().toLowerCase();
    const list = [...items].reverse();
    if (!query) return list;
    return list.filter((item) => item.command.toLowerCase().includes(query));
  }, [items, q]);

  return (
    <div className="listbox">
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索历史命令" />
      <div className="scroll-list">
        {filtered.length === 0 && <div className="empty">暂无历史</div>}
        {filtered.map((item, idx) => (
          <button key={`${item.created_at}-${idx}`} className="list-item" onClick={() => onPick(item.command)} title={item.command}>
            <span>{item.command}</span>
            <small>{new Date(item.created_at).toLocaleString()}</small>
          </button>
        ))}
      </div>
    </div>
  );
}
