import React, { useState, useEffect, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Toggle } from "./toggle";
import { SettingsRow } from "./SettingsSection";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./select";
import { Button } from "./button";
import { RefreshCw, Mic } from "lucide-react";
import { findPreferredBuiltInMicrophone, isBuiltInMicrophone } from "../../utils/audioDeviceUtils";

interface AudioDevice {
  deviceId: string;
  label: string;
  isBuiltIn: boolean;
}

interface MicrophoneSettingsProps {
  preferBuiltInMic: boolean;
  selectedMicDeviceId: string;
  onPreferBuiltInChange: (value: boolean) => void;
  onDeviceSelect: (deviceId: string) => void;
}

export const MicrophoneSettings: React.FC<MicrophoneSettingsProps> = ({
  preferBuiltInMic,
  selectedMicDeviceId,
  onPreferBuiltInChange,
  onDeviceSelect,
}) => {
  const { t } = useTranslation();
  const [devices, setDevices] = useState<AudioDevice[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Use refs to access current values without triggering re-renders
  const preferBuiltInRef = useRef(preferBuiltInMic);
  const selectedDeviceRef = useRef(selectedMicDeviceId);
  const onDeviceSelectRef = useRef(onDeviceSelect);

  // Keep refs in sync
  useEffect(() => {
    preferBuiltInRef.current = preferBuiltInMic;
    selectedDeviceRef.current = selectedMicDeviceId;
    onDeviceSelectRef.current = onDeviceSelect;
  }, [preferBuiltInMic, selectedMicDeviceId, onDeviceSelect]);

  const loadDevices = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      // Request permission first to get device labels
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((track) => track.stop());

      const allDevices = await navigator.mediaDevices.enumerateDevices();
      const audioInputs = allDevices
        .filter((d) => d.kind === "audioinput")
        .map((d) => ({
          deviceId: d.deviceId,
          label: d.label || `Microphone ${d.deviceId.slice(0, 8)}`,
          isBuiltIn: isBuiltInMicrophone(d.label),
        }));

      setDevices(audioInputs);

      // If no device is selected and not preferring built-in, select the first device
      if (!preferBuiltInRef.current && !selectedDeviceRef.current && audioInputs.length > 0) {
        onDeviceSelectRef.current(audioInputs[0].deviceId);
      }
    } catch {
      setError(t("microphoneSettings.errors.unableToAccess"));
    } finally {
      setIsLoading(false);
    }
  }, [t]);

  useEffect(() => {
    loadDevices();

    const handleDeviceChange = () => loadDevices();
    navigator.mediaDevices.addEventListener("devicechange", handleDeviceChange);

    return () => {
      navigator.mediaDevices.removeEventListener("devicechange", handleDeviceChange);
    };
  }, [loadDevices]);

  const builtInDevice = findPreferredBuiltInMicrophone(
    devices.map((device) => ({
      deviceId: device.deviceId,
      label: device.label,
      kind: "audioinput" as const,
    }))
  );
  const selectedDevice = devices.find((d) => d.deviceId === selectedMicDeviceId);

  return (
    <div className="space-y-4">
      <SettingsRow
        label={t("microphoneSettings.preferBuiltIn.label")}
        description={t("microphoneSettings.preferBuiltIn.description")}
      >
        <Toggle
          checked={preferBuiltInMic}
          onChange={onPreferBuiltInChange}
          ariaLabel={t("microphoneSettings.preferBuiltIn.label")}
        />
      </SettingsRow>

      {preferBuiltInMic && builtInDevice && (
        <div className="rounded-lg border border-success/30 bg-success/10 p-3">
          <div className="flex items-center gap-2">
            <Mic className="h-4 w-4 text-success" />
            <span className="text-sm text-success">
              {t("microphoneSettings.using", { device: builtInDevice.label })}
            </span>
          </div>
        </div>
      )}

      {preferBuiltInMic && !builtInDevice && devices.length > 0 && (
        <div className="rounded-lg border border-warning/30 bg-warning/10 p-3">
          <p className="text-sm text-[color:var(--ui-warning-ink)]">
            {t("microphoneSettings.noBuiltInDetected")}
          </p>
        </div>
      )}

      {!preferBuiltInMic && (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <label className="text-sm font-medium text-foreground">
              {t("microphoneSettings.inputDevice")}
            </label>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={loadDevices}
              disabled={isLoading}
              aria-label={t("common.refresh")}
              title={t("common.refresh")}
              className="h-7 w-7 p-0"
            >
              <RefreshCw
                className={`w-3.5 h-3.5 ${isLoading ? "animate-spin" : ""}`}
                aria-hidden="true"
              />
            </Button>
          </div>

          {error ? (
            <p className="text-sm text-destructive">{error}</p>
          ) : (
            <Select
              value={selectedMicDeviceId || "default"}
              onValueChange={(value) => onDeviceSelect(value === "default" ? "" : value)}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder={t("microphoneSettings.selectPlaceholder")}>
                  {selectedMicDeviceId
                    ? selectedDevice?.label || t("microphoneSettings.unknownDevice")
                    : t("microphoneSettings.systemDefault")}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="default">{t("microphoneSettings.systemDefault")}</SelectItem>
                {devices.map((device) => (
                  <SelectItem key={device.deviceId} value={device.deviceId}>
                    {device.label}
                    {device.isBuiltIn && (
                      <span className="ml-2 text-xs text-muted-foreground">
                        {t("microphoneSettings.builtIn")}
                      </span>
                    )}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}

          <p className="text-xs text-muted-foreground">{t("microphoneSettings.helpText")}</p>
        </div>
      )}
    </div>
  );
};

export default MicrophoneSettings;
