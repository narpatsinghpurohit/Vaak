import { useEffect, useCallback } from "react";
import { useHistoryStore } from "../../stores/history.store";

export function useHistory() {
  const {
    entries,
    search,
    selectedIndex,
    loaded,
    load,
    setSearch,
    deleteEntry,
    clearAll,
    togglePin,
    copyEntry,
    selectNext,
    selectPrev,
  } = useHistoryStore();

  useEffect(() => {
    load();
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        selectNext();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        selectPrev();
      } else if (e.key === "Enter") {
        e.preventDefault();
        const entry = entries[selectedIndex];
        if (entry) copyEntry(entry.id);
      }
    },
    [entries, selectedIndex, selectNext, selectPrev, copyEntry],
  );

  return {
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
  };
}
