import React from "react";
import { useSettings } from "./settings.hook";
import { SettingsView } from "./settings.view";

export function Settings() {
  const {
    settings,
    models,
    downloading,
    loaded,
    modelRuntime,
    setProvider,
    selectModel,
    startDownload,
    cancelDownload,
    handleDeleteModel,
    updateField,
    debouncedUpdate,
    triggerLoadModel,
    triggerOffloadModel,
    triggerReloadModel,
  } = useSettings();

  return (
    <SettingsView
      settings={settings}
      models={models}
      downloading={downloading}
      loaded={loaded}
      modelRuntime={modelRuntime}
      onProviderChange={setProvider}
      onSelectModel={selectModel}
      onDownloadModel={startDownload}
      onCancelDownload={cancelDownload}
      onDeleteModel={handleDeleteModel}
      onFieldChange={updateField}
      onDebouncedChange={debouncedUpdate}
      onLoadModel={triggerLoadModel}
      onOffloadModel={triggerOffloadModel}
      onReloadModel={triggerReloadModel}
    />
  );
}
