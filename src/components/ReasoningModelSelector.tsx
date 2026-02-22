import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Cloud, Lock } from "lucide-react";
import ApiKeyInput from "./ui/ApiKeyInput";
import ModelCardList from "./ui/ModelCardList";
import LocalModelPicker, { type LocalProvider } from "./LocalModelPicker";
import { ProviderTabs } from "./ui/ProviderTabs";
import { API_ENDPOINTS, buildApiUrl, normalizeBaseUrl } from "../config/constants";
import { signRequest } from "../utils/awsSigV4";
import { REASONING_PROVIDERS } from "../models/ModelRegistry";
import { modelRegistry } from "../models/ModelRegistry";
import { getProviderIcon, isMonochromeProvider } from "../utils/providerIcons";
import { isSecureEndpoint } from "../utils/urlUtils";
import { createExternalLinkHandler } from "../utils/externalLinks";

type CloudModelOption = {
  value: string;
  label: string;
  description?: string;
  descriptionKey?: string;
  icon?: string;
  ownedBy?: string;
  invertInDark?: boolean;
};

type UnknownRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const pickFirstString = (...candidates: unknown[]): string | undefined => {
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim() !== "") return candidate;
  }
  return undefined;
};

const extractModelEntries = (payload: unknown): unknown[] => {
  if (!isRecord(payload)) return [];

  const directCandidates = [
    payload.data,
    payload.models,
    payload.items,
    payload.results,
    payload.model_list,
    isRecord(payload.result) ? payload.result.data : undefined,
    isRecord(payload.result) ? payload.result.models : undefined,
    isRecord(payload.response) ? payload.response.data : undefined,
    isRecord(payload.response) ? payload.response.models : undefined,
    isRecord(payload.output) ? payload.output.models : undefined,
    isRecord(payload.data) ? payload.data.models : undefined,
    isRecord(payload.data) ? payload.data.items : undefined,
    isRecord(payload.models) ? payload.models.data : undefined,
  ];

  for (const candidate of directCandidates) {
    if (Array.isArray(candidate)) return candidate;
  }

  const objectCandidates = [
    payload.models,
    isRecord(payload.data) ? payload.data.models : undefined,
    payload.model_list,
  ];

  for (const candidate of objectCandidates) {
    if (!isRecord(candidate)) continue;
    return Object.entries(candidate).map(([key, value]) => {
      if (typeof value === "string") {
        return { id: key, name: value };
      }
      if (isRecord(value)) {
        return {
          ...value,
          id: pickFirstString(
            value.id,
            value.name,
            value.model,
            value.model_id,
            value.slug,
            value.value,
            key
          ),
          name: pickFirstString(value.name, value.id, value.model, value.slug, key),
        };
      }
      return { id: key, name: key };
    });
  }

  return [];
};

const extractPayloadError = (payload: unknown): string | undefined => {
  if (!isRecord(payload)) return undefined;
  return pickFirstString(
    payload.error,
    isRecord(payload.error) ? payload.error.message : undefined,
    payload.message,
    payload.detail,
    payload.reason
  );
};

const OWNED_BY_ICON_RULES: Array<{ match: RegExp; provider: string }> = [
  { match: /(openai|system|default|gpt|davinci)/, provider: "openai" },
  { match: /(azure)/, provider: "openai" },
  { match: /(anthropic|claude)/, provider: "anthropic" },
  { match: /(google|gemini)/, provider: "gemini" },
  { match: /(meta|llama)/, provider: "llama" },
  { match: /(mistral)/, provider: "mistral" },
  { match: /(qwen|ali|tongyi)/, provider: "qwen" },
  { match: /(openrouter|oss)/, provider: "openai-oss" },
];

const resolveOwnedByIcon = (ownedBy?: string): { icon?: string; invertInDark: boolean } => {
  if (!ownedBy) return { icon: undefined, invertInDark: false };
  const normalized = ownedBy.toLowerCase();
  const rule = OWNED_BY_ICON_RULES.find(({ match }) => match.test(normalized));
  if (rule) {
    return {
      icon: getProviderIcon(rule.provider),
      invertInDark: isMonochromeProvider(rule.provider),
    };
  }
  return { icon: undefined, invertInDark: false };
};

interface ReasoningModelSelectorProps {
  useReasoningModel: boolean;
  setUseReasoningModel: (value: boolean) => void;
  reasoningModel: string;
  setReasoningModel: (model: string) => void;
  localReasoningProvider: string;
  setLocalReasoningProvider: (provider: string) => void;
  cloudReasoningBaseUrl: string;
  setCloudReasoningBaseUrl: (value: string) => void;
  openaiApiKey: string;
  setOpenaiApiKey: (key: string) => void;
  anthropicApiKey: string;
  setAnthropicApiKey: (key: string) => void;
  geminiApiKey: string;
  setGeminiApiKey: (key: string) => void;
  groqApiKey: string;
  setGroqApiKey: (key: string) => void;
  customReasoningApiKey?: string;
  setCustomReasoningApiKey?: (key: string) => void;
  showAlertDialog: (dialog: { title: string; description: string }) => void;
}

export default function ReasoningModelSelector({
  useReasoningModel,
  setUseReasoningModel,
  reasoningModel,
  setReasoningModel,
  localReasoningProvider,
  setLocalReasoningProvider,
  cloudReasoningBaseUrl,
  setCloudReasoningBaseUrl,
  openaiApiKey,
  setOpenaiApiKey,
  anthropicApiKey,
  setAnthropicApiKey,
  geminiApiKey,
  setGeminiApiKey,
  groqApiKey,
  setGroqApiKey,
  customReasoningApiKey = "",
  setCustomReasoningApiKey,
}: ReasoningModelSelectorProps) {
  const { t } = useTranslation();
  const [selectedMode, setSelectedMode] = useState<"cloud" | "local">("cloud");
  const [selectedCloudProvider, setSelectedCloudProvider] = useState("openai");
  const [selectedLocalProvider, setSelectedLocalProvider] = useState("qwen");
  const [customModelOptions, setCustomModelOptions] = useState<CloudModelOption[]>([]);
  const [customModelsLoading, setCustomModelsLoading] = useState(false);
  const [customModelsError, setCustomModelsError] = useState<string | null>(null);
  const [providerModelsCache, setProviderModelsCache] = useState<Record<string, CloudModelOption[]>>({});
  const providerFetchState = useRef<Record<string, boolean | "done">>({});
  const [providerLoading, setProviderLoading] = useState<Record<string, boolean>>({});
  const [providerError, setProviderError] = useState<Record<string, string | null>>({});

  const DEFAULT_PROVIDER_ENDPOINTS: Record<string, string> = useMemo(() => ({
    openai: "https://api.openai.com/v1",
    anthropic: "https://api.anthropic.com/v1",
    gemini: "https://generativelanguage.googleapis.com/v1beta",
    groq: "https://api.groq.com/openai/v1",
    bedrock: "https://bedrock-runtime.us-east-1.amazonaws.com",
  }), []);

  const [providerEndpoints, setProviderEndpoints] = useState<Record<string, string>>(() => {
    try {
      const saved = localStorage.getItem("providerEndpoints");
      if (saved) return { ...DEFAULT_PROVIDER_ENDPOINTS, ...JSON.parse(saved) };
    } catch { /* ignore */ }
    return { ...DEFAULT_PROVIDER_ENDPOINTS };
  });

  const [providerEndpointInputs, setProviderEndpointInputs] = useState<Record<string, string>>(() => ({
    ...DEFAULT_PROVIDER_ENDPOINTS,
    ...providerEndpoints,
  }));

  const updateProviderEndpoint = useCallback((providerId: string, value: string) => {
    const normalized = normalizeBaseUrl(value) || value.trim();
    setProviderEndpoints((prev) => {
      const next = { ...prev, [providerId]: normalized };
      try { localStorage.setItem("providerEndpoints", JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
    setProviderEndpointInputs((prev) => ({ ...prev, [providerId]: normalized }));
    // Reset fetch state so next refresh uses new endpoint
    providerFetchState.current[providerId] = false;
  }, []);

  // Bedrock-specific state
  const [bedrockAccessKeyId, setBedrockAccessKeyId] = useState(() =>
    localStorage.getItem("bedrockAccessKeyId") || ""
  );
  const [bedrockSecretAccessKey, setBedrockSecretAccessKey] = useState(() =>
    localStorage.getItem("bedrockSecretAccessKey") || ""
  );
  const [bedrockRegion, setBedrockRegion] = useState(() =>
    localStorage.getItem("bedrockRegion") || "us-east-1"
  );

  const saveBedrockCredential = useCallback((key: string, value: string) => {
    localStorage.setItem(key, value);
  }, []);

  const loadBedrockModels = useCallback(async (force = false) => {
    if (!bedrockAccessKeyId || !bedrockSecretAccessKey) return;
    if (!force && providerFetchState.current.bedrock) return;
    providerFetchState.current.bedrock = true;

    setProviderLoading((prev) => ({ ...prev, bedrock: true }));
    setProviderError((prev) => ({ ...prev, bedrock: null }));

    try {
      // Use Bedrock control plane to list foundation models
      const bedrockRegionValue = bedrockRegion || "us-east-1";
      const endpoint = `https://bedrock.${bedrockRegionValue}.amazonaws.com/foundation-models`;

      const signed = await signRequest({
        method: "GET",
        url: endpoint,
        region: bedrockRegionValue,
        service: "bedrock",
        accessKeyId: bedrockAccessKeyId,
        secretAccessKey: bedrockSecretAccessKey,
      });

      const response = await fetch(signed.url, {
        method: "GET",
        headers: signed.headers,
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        throw new Error(`${response.status} ${errorText.slice(0, 200)}`);
      }

      const payload = await response.json();
      const models = (payload.modelSummaries || [])
        .filter((m: any) => m.inferenceTypesSupported?.includes("ON_DEMAND"))
        .map((m: any) => ({
          value: m.modelId,
          label: m.modelId,
          description: m.modelName || m.providerName || undefined,
          icon: getProviderIcon("bedrock"),
        }));

      if (models.length > 0) {
        setProviderModelsCache((prev) => ({ ...prev, bedrock: models }));
        providerFetchState.current.bedrock = "done";
      } else {
        providerFetchState.current.bedrock = false;
      }
    } catch (error) {
      providerFetchState.current.bedrock = false;
      setProviderError((prev) => ({
        ...prev,
        bedrock: (error as Error).message || "Failed to load Bedrock models",
      }));
    } finally {
      setProviderLoading((prev) => ({ ...prev, bedrock: false }));
    }
  }, [bedrockAccessKeyId, bedrockSecretAccessKey, bedrockRegion]);

  const [customBaseInput, setCustomBaseInput] = useState(cloudReasoningBaseUrl);
  const lastLoadedBaseRef = useRef<string | null>(null);
  const pendingBaseRef = useRef<string | null>(null);
  const isMountedRef = useRef(true);

  useEffect(() => {
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    setCustomBaseInput(cloudReasoningBaseUrl);
  }, [cloudReasoningBaseUrl]);

  const defaultOpenAIBase = useMemo(() => normalizeBaseUrl(API_ENDPOINTS.OPENAI_BASE), []);
  const normalizedCustomReasoningBase = useMemo(
    () => normalizeBaseUrl(cloudReasoningBaseUrl),
    [cloudReasoningBaseUrl]
  );
  const latestReasoningBaseRef = useRef(normalizedCustomReasoningBase);

  useEffect(() => {
    latestReasoningBaseRef.current = normalizedCustomReasoningBase;
  }, [normalizedCustomReasoningBase]);

  const hasCustomBase = normalizedCustomReasoningBase !== "";
  const effectiveReasoningBase = hasCustomBase ? normalizedCustomReasoningBase : defaultOpenAIBase;

  const loadRemoteModels = useCallback(
    async (baseOverride?: string, force = false) => {
      const rawBase = (baseOverride ?? cloudReasoningBaseUrl) || "";
      const normalizedBase = normalizeBaseUrl(rawBase);

      if (!normalizedBase) {
        if (isMountedRef.current) {
          setCustomModelsLoading(false);
          setCustomModelsError(null);
          setCustomModelOptions([]);
        }
        return;
      }

      if (!force && lastLoadedBaseRef.current === normalizedBase) return;
      if (!force && pendingBaseRef.current === normalizedBase) return;

      if (baseOverride !== undefined) {
        latestReasoningBaseRef.current = normalizedBase;
      }

      pendingBaseRef.current = normalizedBase;

      if (isMountedRef.current) {
        setCustomModelsLoading(true);
        setCustomModelsError(null);
        setCustomModelOptions([]);
      }

      let apiKey: string | undefined;

      try {
        // Use the custom reasoning API key for custom endpoints
        const keyFromState = customReasoningApiKey?.trim();
        apiKey = keyFromState && keyFromState.length > 0 ? keyFromState : undefined;

        if (!normalizedBase.includes("://")) {
          if (isMountedRef.current && latestReasoningBaseRef.current === normalizedBase) {
            setCustomModelsError(t("reasoning.custom.endpointWithProtocol"));
            setCustomModelsLoading(false);
          }
          return;
        }

        if (!isSecureEndpoint(normalizedBase)) {
          if (isMountedRef.current && latestReasoningBaseRef.current === normalizedBase) {
            setCustomModelsError(t("reasoning.custom.httpsRequired"));
            setCustomModelsLoading(false);
          }
          return;
        }

        const headers: Record<string, string> = {};
        if (apiKey) {
          headers.Authorization = `Bearer ${apiKey}`;
        }

        const modelsUrl = buildApiUrl(normalizedBase, "/models");
        const response = await fetch(modelsUrl, { method: "GET", headers });

        if (!response.ok) {
          const errorText = await response.text().catch(() => "");
          const summary = errorText
            ? `${response.status} ${errorText.slice(0, 200)}`
            : `${response.status} ${response.statusText}`;
          throw new Error(summary.trim());
        }

        const payload = await response.json().catch(() => ({}));
        const payloadError = extractPayloadError(payload);
        if (payloadError) {
          throw new Error(payloadError);
        }

        const rawModels = extractModelEntries(payload);

        const mappedModels = rawModels
          .map((item) => {
            if (typeof item === "string") {
              return {
                value: item,
                label: item,
                description: undefined,
                icon: undefined,
                ownedBy: undefined,
                invertInDark: false,
              } as CloudModelOption;
            }

            if (!isRecord(item)) return null;

            const value = pickFirstString(
              item.id,
              item.name,
              item.model,
              item.model_id,
              item.slug,
              item.value,
              item.identifier,
              item.modelName
            );
            if (!value) return null;
            const ownedBy = pickFirstString(
              item.owned_by,
              item.ownedBy,
              item.provider,
              item.vendor,
              item.organization
            );
            const { icon, invertInDark } = resolveOwnedByIcon(ownedBy);
            const humanName = pickFirstString(item.name, item.display_name, item.title);
            const summary = pickFirstString(item.description, item.summary, item.details);
            const descriptionParts = [
              ...(humanName && humanName !== value ? [humanName] : []),
              ...(summary && summary !== humanName ? [summary] : []),
            ];
            return {
              value,
              // For custom endpoints, always surface raw model ID as the primary text.
              label: value,
              description:
                descriptionParts.join(" · ") ||
                (ownedBy ? t("reasoning.custom.ownerLabel", { owner: ownedBy }) : undefined),
              icon,
              ownedBy,
              invertInDark,
            } as CloudModelOption;
          })
          .filter(Boolean) as CloudModelOption[];

        if (isMountedRef.current && latestReasoningBaseRef.current === normalizedBase) {
          setCustomModelOptions(mappedModels);
          if (
            reasoningModel &&
            mappedModels.length > 0 &&
            !mappedModels.some((model) => model.value === reasoningModel)
          ) {
            setReasoningModel("");
          }
          setCustomModelsError(null);
          lastLoadedBaseRef.current = normalizedBase;
        }
      } catch (error) {
        if (isMountedRef.current && latestReasoningBaseRef.current === normalizedBase) {
          const message = (error as Error).message || t("reasoning.custom.unableToLoadModels");
          const unauthorized = /\b(401|403)\b/.test(message);
          if (unauthorized && !apiKey) {
            setCustomModelsError(t("reasoning.custom.endpointUnauthorized"));
          } else {
            setCustomModelsError(message);
          }
          setCustomModelOptions([]);
        }
      } finally {
        if (pendingBaseRef.current === normalizedBase) {
          pendingBaseRef.current = null;
        }
        if (isMountedRef.current && latestReasoningBaseRef.current === normalizedBase) {
          setCustomModelsLoading(false);
        }
      }
    },
    [cloudReasoningBaseUrl, customReasoningApiKey, reasoningModel, setReasoningModel, t]
  );

  const trimmedCustomBase = customBaseInput.trim();
  const hasSavedCustomBase = Boolean((cloudReasoningBaseUrl || "").trim());
  const isCustomBaseDirty = trimmedCustomBase !== (cloudReasoningBaseUrl || "").trim();

  const displayedCustomModels = useMemo<CloudModelOption[]>(() => {
    if (isCustomBaseDirty) return [];
    return customModelOptions;
  }, [isCustomBaseDirty, customModelOptions]);

  const cloudProviderIds = ["openai", "anthropic", "gemini", "groq", "bedrock", "custom"];
  const cloudProviders = cloudProviderIds.map((id) => ({
    id,
    name:
      id === "custom"
        ? t("reasoning.custom.providerName")
        : id === "bedrock"
          ? "AWS Bedrock"
          : REASONING_PROVIDERS[id as keyof typeof REASONING_PROVIDERS]?.name || id,
  }));

  const localProviders = useMemo<LocalProvider[]>(() => {
    return modelRegistry.getAllProviders().map((provider) => ({
      id: provider.id,
      name: provider.name,
      models: provider.models.map((model) => ({
        id: model.id,
        name: model.name,
        size: model.size,
        sizeBytes: model.sizeBytes,
        description: model.description,
        recommended: model.recommended,
      })),
    }));
  }, []);

  const getProviderModelsUrl = useCallback((providerId: string, apiKey?: string): string => {
    const base = providerEndpoints[providerId] || DEFAULT_PROVIDER_ENDPOINTS[providerId] || "";
    if (!base) return "";
    if (providerId === "gemini") {
      return `${base}/models${apiKey ? `?key=${apiKey}` : ""}`;
    }
    return `${base}/models`;
  }, [providerEndpoints, DEFAULT_PROVIDER_ENDPOINTS]);

  const loadBuiltInProviderModels = useCallback(async (providerId: string, apiKey: string, force = false) => {
    if (!apiKey || providerId === "custom") return;
    // Bedrock uses its own model loading path
    if (providerId === "bedrock") return;

    if (!force && providerFetchState.current[providerId]) return;
    providerFetchState.current[providerId] = true;

    if (isMountedRef.current) {
      setProviderLoading((prev) => ({ ...prev, [providerId]: true }));
      setProviderError((prev) => ({ ...prev, [providerId]: null }));
    }

    try {
      const endpoint = getProviderModelsUrl(providerId, apiKey);
      const headers: Record<string, string> = {};

      if (providerId === "anthropic") {
        headers["x-api-key"] = apiKey;
        headers["anthropic-version"] = "2023-06-01";
      } else if (providerId !== "gemini") {
        // OpenAI, Groq, and other Bearer-token providers
        headers.Authorization = `Bearer ${apiKey}`;
      }

      if (!endpoint) return;

      const response = await fetch(endpoint, { headers });
      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        const summary = errorText
          ? `${response.status} ${errorText.slice(0, 200)}`
          : `${response.status} ${response.statusText}`;
        throw new Error(summary.trim());
      }

      const payload = await response.json().catch(() => ({}));
      const rawModels = extractModelEntries(payload);

      const iconUrl = getProviderIcon(providerId);
      const invertInDark = isMonochromeProvider(providerId);

      const mappedModels = rawModels
        .map((item) => {
          if (typeof item === "string") return { value: item, label: item, icon: iconUrl, invertInDark, _created: 0 } as CloudModelOption & { _created: number };
          if (!isRecord(item)) return null;

          const value = pickFirstString(
            item.id,
            item.name,
            item.model,
            item.model_id,
            item.slug,
            item.value,
            item.identifier,
            item.modelName
          );
          if (!value) return null;

          let displayValue = value;
          if (providerId === "gemini" && displayValue.startsWith("models/")) {
            displayValue = displayValue.replace("models/", "");
          }

          const humanName = pickFirstString(item.name, item.display_name, item.title, item.displayName);
          const summary = pickFirstString(item.description, item.summary, item.details);
          const descriptionParts = [
            ...(humanName && humanName !== displayValue ? [humanName] : []),
            ...(summary && summary !== humanName ? [summary] : []),
          ];

          // Extract creation timestamp for sorting (OpenAI returns 'created' as unix seconds)
          const created = typeof item.created === "number" ? item.created : 0;

          return {
            value: displayValue,
            label: displayValue,
            description: descriptionParts.join(" · ") || undefined,
            icon: iconUrl,
            invertInDark,
            _created: created,
          } as CloudModelOption & { _created: number };
        })
        .filter(Boolean) as (CloudModelOption & { _created: number })[];

      // Sort by creation time, newest first
      mappedModels.sort((a, b) => b._created - a._created);

      if (mappedModels.length > 0) {
        if (isMountedRef.current) {
          setProviderModelsCache((prev) => ({ ...prev, [providerId]: mappedModels }));
          providerFetchState.current[providerId] = "done";
          setProviderError((prev) => ({ ...prev, [providerId]: null }));
        }
      } else {
        providerFetchState.current[providerId] = false;
      }
    } catch (error) {
      providerFetchState.current[providerId] = false;
      if (isMountedRef.current) {
        const message = (error as Error).message || t("reasoning.custom.unableToLoadModels");
        setProviderError((prev) => ({ ...prev, [providerId]: message }));
      }
    } finally {
      if (isMountedRef.current) {
        setProviderLoading((prev) => ({ ...prev, [providerId]: false }));
      }
    }
  }, [t]);

  const handleRefreshProviderModels = useCallback((providerId: string) => {
    const keys: Record<string, string> = {
      openai: openaiApiKey,
      anthropic: anthropicApiKey,
      gemini: geminiApiKey,
      groq: groqApiKey,
    };
    const key = keys[providerId] || "";
    if (!key) return;
    loadBuiltInProviderModels(providerId, key, true);
  }, [openaiApiKey, anthropicApiKey, geminiApiKey, groqApiKey, loadBuiltInProviderModels]);

  const handleProviderEndpointBlur = useCallback((providerId: string) => {
    const input = (providerEndpointInputs[providerId] || "").trim();
    const current = providerEndpoints[providerId] || "";
    if (input && input !== current) {
      updateProviderEndpoint(providerId, input);
    }
  }, [providerEndpointInputs, providerEndpoints, updateProviderEndpoint]);

  useEffect(() => {
    if (selectedMode === "cloud" && selectedCloudProvider !== "custom") {
      const keys: Record<string, string> = {
        openai: openaiApiKey,
        anthropic: anthropicApiKey,
        gemini: geminiApiKey,
        groq: groqApiKey,
      };
      const key = keys[selectedCloudProvider] || "";
      if (key) {
        loadBuiltInProviderModels(selectedCloudProvider, key);
      }
    }
  }, [selectedMode, selectedCloudProvider, openaiApiKey, anthropicApiKey, geminiApiKey, groqApiKey, loadBuiltInProviderModels]);

  const selectedCloudModels = useMemo<CloudModelOption[]>(() => {
    if (selectedCloudProvider === "custom") return displayedCustomModels;

    const dynamicModels = providerModelsCache[selectedCloudProvider];
    const hardcodedProvider = REASONING_PROVIDERS[selectedCloudProvider as keyof typeof REASONING_PROVIDERS];
    const iconUrl = getProviderIcon(selectedCloudProvider);
    const invertInDark = isMonochromeProvider(selectedCloudProvider);

    let baseModels: CloudModelOption[] = [];
    if (dynamicModels && dynamicModels.length > 0) {
      baseModels = [...dynamicModels];
    } else if (hardcodedProvider?.models) {
      baseModels = hardcodedProvider.models.map((model) => ({
        ...model,
        description: model.descriptionKey
          ? t(model.descriptionKey, { defaultValue: model.description })
          : model.description,
        icon: iconUrl,
        invertInDark,
      }));
    } else {
      return [];
    }

    if (dynamicModels && dynamicModels.length > 0 && hardcodedProvider?.models) {
      baseModels = baseModels.map((m) => {
        const hardcoded = hardcodedProvider.models.find(hm => hm.value === m.value);
        if (hardcoded && !m.description) {
          return {
            ...m,
            description: hardcoded.descriptionKey ? t(hardcoded.descriptionKey, { defaultValue: hardcoded.description }) : hardcoded.description
          };
        }
        return m;
      });
    }

    // Always ensure the currently selected model is included so it doesn't break UI if missing
    if (reasoningModel && !baseModels.some(m => m.value === reasoningModel)) {
      baseModels.unshift({
        value: reasoningModel,
        label: reasoningModel,
        description: t("reasoning.custom.ownerLabel", { owner: selectedCloudProvider }),
        icon: iconUrl,
        invertInDark
      });
    }

    return baseModels;
  }, [selectedCloudProvider, displayedCustomModels, providerModelsCache, reasoningModel, t]);

  const handleApplyCustomBase = useCallback(() => {
    const trimmedBase = customBaseInput.trim();
    const normalized = trimmedBase ? normalizeBaseUrl(trimmedBase) : trimmedBase;
    setCustomBaseInput(normalized);
    setCloudReasoningBaseUrl(normalized);
    lastLoadedBaseRef.current = null;
    loadRemoteModels(normalized, true);
  }, [customBaseInput, setCloudReasoningBaseUrl, loadRemoteModels]);

  const handleBaseUrlBlur = useCallback(() => {
    const trimmedBase = customBaseInput.trim();
    if (!trimmedBase) return;

    // Auto-apply on blur if changed
    if (trimmedBase !== (cloudReasoningBaseUrl || "").trim()) {
      handleApplyCustomBase();
    }
  }, [customBaseInput, cloudReasoningBaseUrl, handleApplyCustomBase]);



  const handleRefreshCustomModels = useCallback(() => {
    if (isCustomBaseDirty) {
      handleApplyCustomBase();
      return;
    }
    if (!trimmedCustomBase) return;
    loadRemoteModels(undefined, true);
  }, [handleApplyCustomBase, isCustomBaseDirty, trimmedCustomBase, loadRemoteModels]);

  useEffect(() => {
    const localProviderIds = localProviders.map((p) => p.id);
    if (localProviderIds.includes(localReasoningProvider)) {
      setSelectedMode("local");
      setSelectedLocalProvider(localReasoningProvider);
    } else if (cloudProviderIds.includes(localReasoningProvider)) {
      setSelectedMode("cloud");
      setSelectedCloudProvider(localReasoningProvider);
    }
  }, [localProviders, localReasoningProvider]);

  useEffect(() => {
    if (selectedCloudProvider !== "custom") return;
    if (!hasCustomBase) {
      setCustomModelsError(null);
      setCustomModelOptions([]);
      setCustomModelsLoading(false);
      lastLoadedBaseRef.current = null;
      return;
    }

    const normalizedBase = normalizedCustomReasoningBase;
    if (!normalizedBase) return;
    if (pendingBaseRef.current === normalizedBase || lastLoadedBaseRef.current === normalizedBase)
      return;

    loadRemoteModels();
  }, [selectedCloudProvider, hasCustomBase, normalizedCustomReasoningBase, loadRemoteModels]);

  const [downloadedModels, setDownloadedModels] = useState<Set<string>>(new Set());

  const loadDownloadedModels = useCallback(async () => {
    try {
      const result = await window.electronAPI?.modelGetAll?.();
      if (result && Array.isArray(result)) {
        const downloaded = new Set(
          result
            .filter((m: { isDownloaded?: boolean }) => m.isDownloaded)
            .map((m: { id: string }) => m.id)
        );
        setDownloadedModels(downloaded);
        return downloaded;
      }
    } catch (error) {
      console.error("Failed to load downloaded models:", error);
    }
    return new Set<string>();
  }, []);

  useEffect(() => {
    loadDownloadedModels();
  }, [loadDownloadedModels]);

  const handleModeChange = async (newMode: "cloud" | "local") => {
    setSelectedMode(newMode);

    if (newMode === "cloud") {
      setLocalReasoningProvider(selectedCloudProvider);

      if (selectedCloudProvider === "custom") {
        setCustomBaseInput(cloudReasoningBaseUrl);
        lastLoadedBaseRef.current = null;
        pendingBaseRef.current = null;

        if (customModelOptions.length > 0) {
          setReasoningModel(customModelOptions[0].value);
        } else if (hasCustomBase) {
          loadRemoteModels();
        }
        return;
      }

      const provider =
        REASONING_PROVIDERS[selectedCloudProvider as keyof typeof REASONING_PROVIDERS];
      if (provider?.models?.length > 0) {
        setReasoningModel(provider.models[0].value);
      }
    } else {
      setLocalReasoningProvider(selectedLocalProvider);
      const downloaded = await loadDownloadedModels();
      const provider = localProviders.find((p) => p.id === selectedLocalProvider);
      const models = provider?.models ?? [];
      if (models.length > 0) {
        const firstDownloaded = models.find((m) => downloaded.has(m.id));
        if (firstDownloaded) {
          setReasoningModel(firstDownloaded.id);
        } else {
          setReasoningModel("");
        }
      }
    }
  };

  const handleCloudProviderChange = (provider: string) => {
    setSelectedCloudProvider(provider);
    setLocalReasoningProvider(provider);

    if (provider === "custom") {
      setCustomBaseInput(cloudReasoningBaseUrl);
      lastLoadedBaseRef.current = null;
      pendingBaseRef.current = null;

      if (customModelOptions.length > 0) {
        setReasoningModel(customModelOptions[0].value);
      } else if (hasCustomBase) {
        loadRemoteModels();
      }
      return;
    }

    if (provider === "bedrock") {
      const cachedModels = providerModelsCache.bedrock;
      if (cachedModels?.length > 0) {
        setReasoningModel(cachedModels[0].value);
      } else if (bedrockAccessKeyId && bedrockSecretAccessKey) {
        loadBedrockModels();
      }
      return;
    }

    const providerData = REASONING_PROVIDERS[provider as keyof typeof REASONING_PROVIDERS];
    if (providerData?.models?.length > 0) {
      setReasoningModel(providerData.models[0].value);
    }
  };

  const handleLocalProviderChange = async (providerId: string) => {
    setSelectedLocalProvider(providerId);
    setLocalReasoningProvider(providerId);
    const downloaded = await loadDownloadedModels();
    const provider = localProviders.find((p) => p.id === providerId);
    const models = provider?.models ?? [];
    if (models.length > 0) {
      const firstDownloaded = models.find((m) => downloaded.has(m.id));
      if (firstDownloaded) {
        setReasoningModel(firstDownloaded.id);
      } else {
        setReasoningModel("");
      }
    }
  };

  const MODE_TABS = [
    { id: "cloud", name: t("reasoning.mode.cloud") },
    { id: "local", name: t("reasoning.mode.local") },
  ];

  const renderModeIcon = (id: string) => {
    if (id === "cloud") return <Cloud className="w-4 h-4" />;
    return <Lock className="w-4 h-4" />;
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between p-3 bg-card border border-border rounded-lg">
        <div>
          <label className="text-sm font-medium text-foreground">
            {t("reasoning.enableTitle")}
          </label>
          <p className="text-xs text-muted-foreground">{t("reasoning.enableDescription")}</p>
        </div>
        <button
          onClick={() => setUseReasoningModel(!useReasoningModel)}
          className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors duration-200 ${useReasoningModel ? "bg-primary" : "bg-muted-foreground/25"
            }`}
        >
          <span
            className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform duration-200 ${useReasoningModel ? "translate-x-4.5" : "translate-x-0.75"
              }`}
          />
        </button>
      </div>

      {useReasoningModel && (
        <>
          <div className="space-y-2">
            <ProviderTabs
              providers={MODE_TABS}
              selectedId={selectedMode}
              onSelect={(id) => handleModeChange(id as "cloud" | "local")}
              renderIcon={renderModeIcon}
              colorScheme="purple"
            />
            <p className="text-xs text-muted-foreground text-center">
              {selectedMode === "local"
                ? t("reasoning.mode.localDescription")
                : t("reasoning.mode.cloudDescription")}
            </p>
          </div>

          {selectedMode === "cloud" ? (
            <div className="space-y-2">
              <div className="border border-border rounded-lg overflow-hidden">
                <ProviderTabs
                  providers={cloudProviders}
                  selectedId={selectedCloudProvider}
                  onSelect={handleCloudProviderChange}
                  colorScheme="indigo"
                />

                <div className="p-3">
                  {selectedCloudProvider === "custom" ? (
                    <>
                      {/* 1. Endpoint URL - TOP */}
                      <div className="space-y-2">
                        <h4 className="font-medium text-foreground">
                          {t("reasoning.custom.endpointTitle")}
                        </h4>
                        <Input
                          value={customBaseInput}
                          onChange={(event) => setCustomBaseInput(event.target.value)}
                          onBlur={handleBaseUrlBlur}
                          placeholder="https://api.openai.com/v1"
                          className="text-sm"
                        />
                        <p className="text-xs text-muted-foreground">
                          {t("reasoning.custom.endpointExamples")}{" "}
                          <code className="text-primary">http://localhost:11434/v1</code>{" "}
                          {t("reasoning.custom.ollama")},{" "}
                          <code className="text-primary">http://localhost:8080/v1</code>{" "}
                          {t("reasoning.custom.localAi")}.
                        </p>
                      </div>

                      {/* 2. API Key - SECOND */}
                      <div className="space-y-2 pt-3">
                        <h4 className="font-medium text-foreground">
                          {t("reasoning.custom.apiKeyOptional")}
                        </h4>
                        <ApiKeyInput
                          apiKey={customReasoningApiKey}
                          setApiKey={setCustomReasoningApiKey || (() => { })}
                          label=""
                          helpText={t("reasoning.custom.apiKeyHelp")}
                        />
                      </div>

                      {/* 3. Model Selection - THIRD */}
                      <div className="space-y-2 pt-3">
                        <div className="flex items-center justify-between">
                          <h4 className="text-sm font-medium text-foreground">
                            {t("reasoning.availableModels")}
                          </h4>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={handleRefreshCustomModels}
                            disabled={
                              customModelsLoading || (!trimmedCustomBase && !hasSavedCustomBase)
                            }
                            className="text-xs"
                          >
                            {customModelsLoading
                              ? t("common.loading")
                              : isCustomBaseDirty
                                ? t("reasoning.custom.applyAndRefresh")
                                : t("common.refresh")}
                          </Button>
                        </div>
                        <p className="text-xs text-muted-foreground">
                          {t("reasoning.custom.queryPrefix")}{" "}
                          <code>
                            {hasCustomBase
                              ? `${effectiveReasoningBase}/models`
                              : `${defaultOpenAIBase}/models`}
                          </code>{" "}
                          {t("reasoning.custom.querySuffix")}
                        </p>
                        {isCustomBaseDirty && (
                          <p className="text-xs text-primary">
                            {t("reasoning.custom.modelsReloadHint")}
                          </p>
                        )}
                        {!hasCustomBase && (
                          <p className="text-xs text-warning">
                            {t("reasoning.custom.enterEndpoint")}
                          </p>
                        )}
                        {hasCustomBase && (
                          <>
                            {customModelsLoading && (
                              <p className="text-xs text-primary">
                                {t("reasoning.custom.fetchingModels")}
                              </p>
                            )}
                            {customModelsError && (
                              <p className="text-xs text-destructive">{customModelsError}</p>
                            )}
                            {!customModelsLoading &&
                              !customModelsError &&
                              customModelOptions.length === 0 && (
                                <p className="text-xs text-warning">
                                  {t("reasoning.custom.noModels")}
                                </p>
                              )}
                          </>
                        )}
                        <ModelCardList
                          models={selectedCloudModels}
                          selectedModel={reasoningModel}
                          onModelSelect={setReasoningModel}
                        />
                      </div>
                    </>
                  ) : selectedCloudProvider === "bedrock" ? (
                    <>
                      {/* Bedrock: Access Key ID */}
                      <div className="space-y-2">
                        <h4 className="text-sm font-medium text-foreground">Access Key ID</h4>
                        <Input
                          type="password"
                          value={bedrockAccessKeyId}
                          onChange={(e) => {
                            setBedrockAccessKeyId(e.target.value);
                            saveBedrockCredential("bedrockAccessKeyId", e.target.value);
                          }}
                          placeholder="AKIA..."
                          className="text-sm"
                        />
                      </div>

                      {/* Bedrock: Secret Access Key */}
                      <div className="space-y-2 pt-2">
                        <h4 className="text-sm font-medium text-foreground">Secret Access Key</h4>
                        <Input
                          type="password"
                          value={bedrockSecretAccessKey}
                          onChange={(e) => {
                            setBedrockSecretAccessKey(e.target.value);
                            saveBedrockCredential("bedrockSecretAccessKey", e.target.value);
                          }}
                          placeholder="wJalr..."
                          className="text-sm"
                        />
                      </div>

                      {/* Bedrock: Region */}
                      <div className="space-y-2 pt-2">
                        <h4 className="text-sm font-medium text-foreground">Region</h4>
                        <Input
                          value={bedrockRegion}
                          onChange={(e) => {
                            setBedrockRegion(e.target.value);
                            saveBedrockCredential("bedrockRegion", e.target.value);
                          }}
                          placeholder="us-east-1"
                          className="text-sm"
                        />
                      </div>

                      {/* Bedrock: Endpoint URL */}
                      <div className="pt-3 space-y-2">
                        <h4 className="text-sm font-medium text-foreground">
                          {t("reasoning.custom.endpointTitle")}
                        </h4>
                        <Input
                          value={providerEndpointInputs.bedrock || ""}
                          onChange={(e) => setProviderEndpointInputs((prev) => ({ ...prev, bedrock: e.target.value }))}
                          onBlur={() => handleProviderEndpointBlur("bedrock")}
                          placeholder={`https://bedrock-runtime.${bedrockRegion || "us-east-1"}.amazonaws.com`}
                          className="text-sm"
                        />
                        <p className="text-xs text-muted-foreground">
                          默认根据 Region 自动生成，自定义端点可用于 VPC Endpoint 等场景
                        </p>
                      </div>

                      {/* Bedrock: Model Selection */}
                      <div className="pt-3 space-y-2">
                        <div className="flex items-center justify-between">
                          <h4 className="text-sm font-medium text-foreground">
                            {t("reasoning.availableModels")}
                          </h4>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => loadBedrockModels(true)}
                            disabled={providerLoading.bedrock || !bedrockAccessKeyId || !bedrockSecretAccessKey}
                            className="text-xs"
                          >
                            {providerLoading.bedrock ? t("common.loading") : t("common.refresh")}
                          </Button>
                        </div>
                        {providerLoading.bedrock && (
                          <p className="text-xs text-primary">{t("reasoning.custom.fetchingModels")}</p>
                        )}
                        {providerError.bedrock && (
                          <p className="text-xs text-destructive">{providerError.bedrock}</p>
                        )}
                        <ModelCardList
                          models={selectedCloudModels}
                          selectedModel={reasoningModel}
                          onModelSelect={setReasoningModel}
                        />
                      </div>
                    </>
                  ) : (
                    <>
                      {/* 1. API Key - TOP */}
                      {selectedCloudProvider === "openai" && (
                        <div className="space-y-2">
                          <div className="flex items-baseline justify-between">
                            <h4 className="font-medium text-foreground">{t("common.apiKey")}</h4>
                            <a
                              href="https://platform.openai.com/api-keys"
                              target="_blank"
                              rel="noopener noreferrer"
                              onClick={createExternalLinkHandler(
                                "https://platform.openai.com/api-keys"
                              )}
                              className="text-xs text-link underline decoration-link/30 hover:decoration-link/60 cursor-pointer transition-colors"
                            >
                              {t("reasoning.getApiKey")}
                            </a>
                          </div>
                          <ApiKeyInput
                            apiKey={openaiApiKey}
                            setApiKey={setOpenaiApiKey}
                            label=""
                            helpText=""
                          />
                        </div>
                      )}

                      {selectedCloudProvider === "anthropic" && (
                        <div className="space-y-2">
                          <div className="flex items-baseline justify-between">
                            <h4 className="font-medium text-foreground">{t("common.apiKey")}</h4>
                            <a
                              href="https://console.anthropic.com/settings/keys"
                              target="_blank"
                              rel="noopener noreferrer"
                              onClick={createExternalLinkHandler(
                                "https://console.anthropic.com/settings/keys"
                              )}
                              className="text-xs text-link underline decoration-link/30 hover:decoration-link/60 cursor-pointer transition-colors"
                            >
                              {t("reasoning.getApiKey")}
                            </a>
                          </div>
                          <ApiKeyInput
                            apiKey={anthropicApiKey}
                            setApiKey={setAnthropicApiKey}
                            placeholder="sk-ant-..."
                            label=""
                            helpText=""
                          />
                        </div>
                      )}

                      {selectedCloudProvider === "gemini" && (
                        <div className="space-y-2">
                          <div className="flex items-baseline justify-between">
                            <h4 className="font-medium text-foreground">{t("common.apiKey")}</h4>
                            <a
                              href="https://aistudio.google.com/app/api-keys"
                              target="_blank"
                              rel="noopener noreferrer"
                              onClick={createExternalLinkHandler(
                                "https://aistudio.google.com/app/api-keys"
                              )}
                              className="text-xs text-link underline decoration-link/30 hover:decoration-link/60 cursor-pointer transition-colors"
                            >
                              {t("reasoning.getApiKey")}
                            </a>
                          </div>
                          <ApiKeyInput
                            apiKey={geminiApiKey}
                            setApiKey={setGeminiApiKey}
                            placeholder="AIza..."
                            label=""
                            helpText=""
                          />
                        </div>
                      )}

                      {selectedCloudProvider === "groq" && (
                        <div className="space-y-2">
                          <div className="flex items-baseline justify-between">
                            <h4 className="font-medium text-foreground">{t("common.apiKey")}</h4>
                            <a
                              href="https://console.groq.com/keys"
                              target="_blank"
                              rel="noopener noreferrer"
                              onClick={createExternalLinkHandler("https://console.groq.com/keys")}
                              className="text-xs text-link underline decoration-link/30 hover:decoration-link/60 cursor-pointer transition-colors"
                            >
                              {t("reasoning.getApiKey")}
                            </a>
                          </div>
                          <ApiKeyInput
                            apiKey={groqApiKey}
                            setApiKey={setGroqApiKey}
                            placeholder="gsk_..."
                            label=""
                            helpText=""
                          />
                        </div>
                      )}

                      {/* 2. Endpoint URL */}
                      <div className="pt-3 space-y-2">
                        <h4 className="text-sm font-medium text-foreground">
                          {t("reasoning.custom.endpointTitle")}
                        </h4>
                        <Input
                          value={providerEndpointInputs[selectedCloudProvider] || ""}
                          onChange={(e) => setProviderEndpointInputs((prev) => ({ ...prev, [selectedCloudProvider]: e.target.value }))}
                          onBlur={() => handleProviderEndpointBlur(selectedCloudProvider)}
                          placeholder={DEFAULT_PROVIDER_ENDPOINTS[selectedCloudProvider] || ""}
                          className="text-sm"
                        />
                      </div>

                      {/* 3. Model Selection - BOTTOM */}
                      <div className="pt-3 space-y-2">
                        <div className="flex items-center justify-between">
                          <h4 className="text-sm font-medium text-foreground">
                            {t("reasoning.availableModels")}
                          </h4>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => handleRefreshProviderModels(selectedCloudProvider)}
                            disabled={
                              providerLoading[selectedCloudProvider] ||
                              !{
                                openai: openaiApiKey,
                                anthropic: anthropicApiKey,
                                gemini: geminiApiKey,
                                groq: groqApiKey,
                              }[selectedCloudProvider]
                            }
                            className="text-xs"
                          >
                            {providerLoading[selectedCloudProvider]
                              ? t("common.loading")
                              : t("common.refresh")}
                          </Button>
                        </div>
                        <p className="text-xs text-muted-foreground">
                          {t("reasoning.custom.queryPrefix")}{" "}
                          <code>{getProviderModelsUrl(selectedCloudProvider)}</code>{" "}
                          {t("reasoning.custom.querySuffix")}
                        </p>
                        {providerLoading[selectedCloudProvider] && (
                          <p className="text-xs text-primary">
                            {t("reasoning.custom.fetchingModels")}
                          </p>
                        )}
                        {providerError[selectedCloudProvider] && (
                          <p className="text-xs text-destructive">
                            {providerError[selectedCloudProvider]}
                          </p>
                        )}
                        <ModelCardList
                          models={selectedCloudModels}
                          selectedModel={reasoningModel}
                          onModelSelect={setReasoningModel}
                        />
                      </div>
                    </>
                  )}
                </div>
              </div>
            </div>
          ) : (
            <LocalModelPicker
              providers={localProviders}
              selectedModel={reasoningModel}
              selectedProvider={selectedLocalProvider}
              onModelSelect={setReasoningModel}
              onProviderSelect={handleLocalProviderChange}
              modelType="llm"
              colorScheme="purple"
              onDownloadComplete={loadDownloadedModels}
            />
          )}
        </>
      )}
    </div>
  );
}
