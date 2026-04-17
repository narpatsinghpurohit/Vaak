import { useEffect, useCallback, useRef } from "react";
import { useSettingsStore } from "../../stores/settings.store";

export function useSettings() {
  const {
    settings,
    models,
    downloading,
    loaded,
    modelRuntime,
    load,
    save,
    loadModels,
    startDownload,
    cancelDownload,
    deleteModel,
    selectModel,
    setProvider,
    loadModelRuntime,
    triggerLoadModel,
    triggerOffloadModel,
    triggerReloadModel,
  } = useSettingsStore();

  const saveTimerRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    load();
    loadModels();
    loadModelRuntime();
  }, []);

  const updateField = useCallback(
    (updater: (s: Settings) => Settings) => {
      if (!settings) return;
      const updated = updater({ ...settings });
      save(updated);
    },
    [settings, save],
  );

  const debouncedUpdate = useCallback(
    (updater: (s: Settings) => Settings) => {
      if (!settings) return;
      const updated = updater({ ...settings });
      // Optimistic local update
      useSettingsStore.setState({ settings: updated });
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => save(updated), 500);
    },
    [settings, save],
  );

  const handleDeleteModel = useCallback(
    (filename: string, displayName: string) => {
      if (confirm(`Delete ${displayName}?`)) {
        deleteModel(filename);
      }
    },
    [deleteModel],
  );

  return {
    settings,
    models,
    downloading,
    loaded,
    modelRuntime,
    loadModels,
    setProvider,
    selectModel,
    startDownload,
    cancelDownload,
    handleDeleteModel,
    updateField,
    debouncedUpdate,
    loadModelRuntime,
    triggerLoadModel,
    triggerOffloadModel,
    triggerReloadModel,
  };
}
