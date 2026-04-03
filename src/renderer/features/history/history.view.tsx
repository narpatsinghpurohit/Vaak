import React from "react";

function formatTime(iso: string): string {
  try {
    const d = new Date(iso + "Z");
    const diff = Date.now() - d.getTime();
    if (diff < 60000) return "just now";
    if (diff < 3600000) return Math.floor(diff / 60000) + "m ago";
    if (diff < 86400000) return Math.floor(diff / 3600000) + "h ago";
    return d.toLocaleDateString();
  } catch {
    return iso;
  }
}

interface HistoryViewProps {
  entries: HistoryEntry[];
  search: string;
  selectedIndex: number;
  loaded: boolean;
  onSearchChange: (search: string) => void;
  onCopy: (id: number) => void;
  onDelete: (id: number) => void;
  onTogglePin: (id: number) => void;
  onClearAll: () => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
}

export function HistoryView({
  entries,
  search,
  selectedIndex,
  loaded,
  onSearchChange,
  onCopy,
  onDelete,
  onTogglePin,
  onClearAll,
  onKeyDown,
}: HistoryViewProps) {
  return (
    <div className="history-container" onKeyDown={onKeyDown} tabIndex={0}>
      <div className="history-header">
        <span>Vaak History</span>
      </div>

      <div className="search-bar">
        <input
          type="text"
          placeholder="Search transcriptions..."
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          autoFocus
        />
      </div>

      <div className="history-list">
        {!loaded ? (
          <div className="empty">Loading...</div>
        ) : entries.length === 0 ? (
          <div className="empty">
            {search ? "No matches" : "No transcriptions yet"}
          </div>
        ) : (
          entries.map((entry, i) => (
            <div
              key={entry.id}
              className={`entry ${i === selectedIndex ? "selected" : ""}`}
              onClick={() => onCopy(entry.id)}
              onContextMenu={(e) => {
                e.preventDefault();
                onTogglePin(entry.id);
              }}
            >
              <div className="entry-text">
                {entry.pinned ? "\uD83D\uDCCC " : ""}
                {entry.text}
              </div>
              <div className="entry-meta">
                <span>{entry.provider}</span>
                <span>{formatTime(entry.created_at)}</span>
                <button
                  className="entry-delete"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(entry.id);
                  }}
                >
                  x
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      <div className="history-footer">
        <span>{entries.length} items</span>
        <span>Click to copy | Right-click to pin</span>
        {entries.length > 0 && (
          <button className="clear-btn" onClick={onClearAll}>
            Clear all
          </button>
        )}
      </div>
    </div>
  );
}
