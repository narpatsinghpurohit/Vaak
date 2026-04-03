import React from "react";
import { useHistory } from "./history.hook";
import { HistoryView } from "./history.view";

export function History() {
  const {
    entries,
    search,
    selectedIndex,
    loaded,
    setSearch,
    deleteEntry,
    clearAll,
    togglePin,
    copyEntry,
    handleKeyDown,
  } = useHistory();

  return (
    <HistoryView
      entries={entries}
      search={search}
      selectedIndex={selectedIndex}
      loaded={loaded}
      onSearchChange={setSearch}
      onCopy={copyEntry}
      onDelete={deleteEntry}
      onTogglePin={togglePin}
      onClearAll={clearAll}
      onKeyDown={handleKeyDown}
    />
  );
}
