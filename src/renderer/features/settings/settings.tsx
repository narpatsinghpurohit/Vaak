import React from "react";
import { useSettings } from "./settings.hook";
import { SettingsView } from "./settings.view";

export function Settings() {
  const {
    settings,
    models,
    downloading,
    loaded,
    setProvider,
    selectModel,
    startDownload,
    cancelDownload,
    handleDeleteModel,
    updateField,
    debouncedUpdate,
  } = useSettings();

  return (
    <SettingsView
      settings={settings}
      models={models}
      downloading={downloading}
      loaded={loaded}
      onProviderChange={setProvider}
      onSelectModel={selectModel}
      onDownloadModel={startDownload}
      onCancelDownload={cancelDownload}
      onDeleteModel={handleDeleteModel}
      onFieldChange={updateField}
      onDebouncedChange={debouncedUpdate}
    />
  );
}
