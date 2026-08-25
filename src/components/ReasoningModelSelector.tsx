import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import ApiKeyInput from "./ui/ApiKeyInput";
import ModelCardList from "./ui/ModelCardList";
import LocalModelPicker, { type LocalProvider } from "./LocalModelPicker";
import { ProviderTabs } from "./ui/ProviderTabs";
import ProcessingModeSelector from "./ui/ProcessingModeSelector";
import {
  API_ENDPOINTS,
  buildGeminiGenerateContentUrl,
  buildModelsUrl,
  getGeminiEndpointFamily,
  getGeminiGenerateContentEndpointInfo,
  getGeminiRequestBaseUrl,
  getEndpointBaseUrl,
  isOpenAiCompatibleGeminiEndpoint,
  isOfficialGoogleGeminiEndpoint,
  normalizeBaseUrl,
  normalizeEndpointUrl,
} from "../config/constants";
import { signRequest } from "../utils/awsSigV4";
import {
  getLocalReasoningProviderIdForModel,
  isLocalReasoningProviderId,
  modelRegistry,
  REASONING_PROVIDERS,
} from "../models/ModelRegistry";
import { getProviderIcon, isMonochromeProvider } from "../utils/providerIcons";
import { isSecureEndpoint } from "../utils/urlUtils";
import { createExternalLinkHandler } from "../utils/externalLinks";
import { getProviderGuideUrl } from "../utils/providerGuideLinks";
import { isAppShuttingDownError } from "../utils/modelRequestLifecycle";
import ReasoningService from "../services/ReasoningService";
import {
  CUSTOM_GEMINI_GENERATE_CONTENT_PROTOCOL,
  type CustomReasoningProtocol,
} from "../utils/customReasoningProtocol";

type CloudModelOption = {
  value: string;
  label: string;
  description?: string;
  descriptionKey?: string;
  icon?: string;
  ownedBy?: string;
  invertInDark?: boolean;
  _created?: number;
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

const parseTimestampCandidate = (candidate: unknown): number => {
  if (typeof candidate === "number" && Number.isFinite(candidate) && candidate > 0) {
    // Normalize to epoch milliseconds.
    return candidate > 1e11 ? Math.floor(candidate) : Math.floor(candidate * 1000);
  }

  if (typeof candidate === "string") {
    const trimmed = candidate.trim();
    if (!trimmed) return 0;

    if (/^\d+$/.test(trimmed)) {
      const numeric = Number(trimmed);
      if (Number.isFinite(numeric) && numeric > 0) {
        return numeric > 1e11 ? Math.floor(numeric) : Math.floor(numeric * 1000);
      }
    }

    const parsed = Date.parse(trimmed);
    if (!Number.isNaN(parsed) && parsed > 0) return parsed;
  }

  return 0;
};

const extractReleaseTimestamp = (record: UnknownRecord): number => {
  const lifecycle = isRecord(record.lifecycle) ? record.lifecycle : undefined;
  const metadata = isRecord(record.metadata) ? record.metadata : undefined;

  const candidates = [
    // Common model APIs
    record.created,
    record.created_at,
    record.createdAt,
    record.published,
    record.published_at,
    record.publishedAt,
    record.release_date,
    record.releaseDate,
    record.released_at,
    record.releasedAt,
    record.release_timestamp,
    record.releaseTimestamp,
    // Fallback temporal metadata
    record.updated_at,
    record.updatedAt,
    record.modified_at,
    record.modifiedAt,
    record.last_updated,
    record.lastUpdated,
    // Nested lifecycle/metadata objects
    lifecycle?.created_at,
    lifecycle?.createdAt,
    lifecycle?.release_date,
    lifecycle?.releaseDate,
    lifecycle?.released_at,
    lifecycle?.releasedAt,
    metadata?.created_at,
    metadata?.createdAt,
    metadata?.published_at,
    metadata?.publishedAt,
    metadata?.release_date,
    metadata?.releaseDate,
    metadata?.released_at,
    metadata?.releasedAt,
  ];

  for (const candidate of candidates) {
    const ts = parseTimestampCandidate(candidate);
    if (ts > 0) return ts;
  }

  return 0;
};

const extractVersionScore = (modelId: string): number => {
  const normalized = modelId.toLowerCase();

  // "latest" tags should naturally float to the top.
  if (/\blatest\b/.test(normalized)) return Number.MAX_SAFE_INTEGER - 1;

  // Prefer sortable date tokens inside IDs (e.g. 20241022 / 2024-10-22).
  const dateToken = normalized.match(
    /((?:19|20)\d{2})[-_.]?((?:0[1-9]|1[0-2]))[-_.]?((?:0[1-9]|[12]\d|3[01]))/
  );
  if (dateToken) {
    const year = Number(dateToken[1]);
    const month = Number(dateToken[2]);
    const day = Number(dateToken[3]);
    const dateMs = Date.UTC(year, month - 1, day);
    if (Number.isFinite(dateMs) && dateMs > 0) return dateMs;
  }

  // Fallback: semantic-ish numeric score from first numeric groups (e.g. 5.2 > 4.1).
  const numericChunks = normalized.match(/\d+/g);
  if (!numericChunks || numericChunks.length === 0) return 0;

  const major = Number(numericChunks[0] ?? "0");
  const minor = Number(numericChunks[1] ?? "0");
  const patch = Number(numericChunks[2] ?? "0");
  if (![major, minor, patch].every((n) => Number.isFinite(n) && n >= 0)) return 0;

  return major * 1_000_000 + minor * 1_000 + patch;
};

const compareModelsByRecency = (
  a: { value: string; _created?: number },
  b: { value: string; _created?: number }
): number => {
  const aCreated = a._created ?? 0;
  const bCreated = b._created ?? 0;
  if (aCreated !== bCreated) return bCreated - aCreated;

  const aVersionScore = extractVersionScore(a.value);
  const bVersionScore = extractVersionScore(b.value);
  if (aVersionScore !== bVersionScore) return bVersionScore - aVersionScore;

  return b.value.localeCompare(a.value, undefined, { numeric: true, sensitivity: "base" });
};

const prioritizeSelectedModel = (
  models: CloudModelOption[],
  selectedModel: string
): CloudModelOption[] => {
  if (!selectedModel) return models;

  const selectedIndex = models.findIndex((model) => model.value === selectedModel);
  if (selectedIndex <= 0) return models;

  const next = [...models];
  const [selected] = next.splice(selectedIndex, 1);
  next.unshift(selected);
  return next;
};

type OfficialGeminiApiVersion = "v1" | "v1beta" | "other";

const getOfficialGoogleGeminiApiVersion = (endpoint?: string | null): OfficialGeminiApiVersion => {
  if (!isOfficialGoogleGeminiEndpoint(endpoint)) return "other";
  const normalized = getGeminiRequestBaseUrl(endpoint) || getEndpointBaseUrl(endpoint);
  if (/\/v1beta$/i.test(normalized)) return "v1beta";
  if (/\/v1$/i.test(normalized)) return "v1";
  return "other";
};

const toOfficialGoogleGeminiV1BetaEndpoint = (endpoint?: string | null): string => {
  const normalized = getGeminiRequestBaseUrl(endpoint) || getEndpointBaseUrl(endpoint);
  if (/\/v1$/i.test(normalized)) {
    return normalized.replace(/\/v1$/i, "/v1beta");
  }
  return normalized || "https://generativelanguage.googleapis.com/v1beta";
};

const OWNED_BY_ICON_RULES: Array<{ match: RegExp; provider: string }> = [
  { match: /(openai|system|default|gpt|davinci)/, provider: "openai" },
  { match: /(azure)/, provider: "openai" },
  { match: /(anthropic|claude)/, provider: "anthropic" },
  { match: /(google|gemini)/, provider: "gemini" },
  { match: /(meta|llama)/, provider: "llama" },
  { match: /(mistral)/, provider: "mistral" },
  { match: /(qwen|ali|tongyi)/, provider: "qwen" },
  { match: /(openrouter)/, provider: "openrouter" },
  { match: /(oss)/, provider: "openai-oss" },
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

const PROVIDER_MODELS_CACHE_KEY = "chordvox_reasoning_provider_models_cache";
const CUSTOM_MODELS_CACHE_KEY = "chordvox_reasoning_custom_models_cache";
const LOCAL_REASONING_PROVIDER_STORAGE_KEY = "chordvox_local_reasoning_provider";
const MODEL_LIST_TIMEOUT_MS = 15000;
const MODEL_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const shouldRetryModelsFetchWithProxy = (error: unknown): boolean => {
  const message = String((error as Error)?.message || "").toLowerCase();
  return (
    message.includes("failed to fetch") ||
    message.includes("networkerror") ||
    message.includes("load failed")
  );
};

const fetchModelsWithProxyFallback = async (
  url: string,
  headers: Record<string, string>
): Promise<Response> => {
  const proxy = typeof window !== "undefined" ? window.electronAPI?.proxyReasoningRequest : null;
  if (typeof proxy === "function") {
    const requestId = `models-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timeoutId = setTimeout(() => {
        window.electronAPI?.cancelReasoningProxyRequest?.({ requestId }).catch(() => {});
        reject(new Error("Model list request timed out after 15s"));
      }, MODEL_LIST_TIMEOUT_MS);
    });

    let result: Awaited<ReturnType<typeof proxy>>;
    try {
      result = await Promise.race([
        proxy({
          requestId,
          url,
          method: "GET",
          headers,
          stream: false,
        }),
        timeout,
      ]);
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }

    if (!result?.success) {
      const error = new Error(
        result?.message || result?.error || "Model list proxy request failed"
      ) as Error & { code?: string };
      if (result?.code) error.code = result.code;
      throw error;
    }

    return new Response(result.body || "", {
      status: result.status ?? 502,
      statusText: result.statusText || "",
      headers: result.headers || {},
    });
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), MODEL_LIST_TIMEOUT_MS);
  try {
    return await fetch(url, { method: "GET", headers, signal: controller.signal });
  } catch (error) {
    if ((error as Error)?.name === "AbortError") {
      throw new Error("Model list request timed out after 15s");
    }
    if (!shouldRetryModelsFetchWithProxy(error)) {
      throw error;
    }
    throw new Error("Unable to reach the model endpoint from this app window.");
  } finally {
    clearTimeout(timeoutId);
  }
};

const readStorageJson = <T,>(key: string, fallback: T): T => {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
};

type ModelCacheEntry = {
  models: CloudModelOption[];
  cachedAt: number;
};

type ModelCacheMap = Record<string, ModelCacheEntry>;

const readFreshModelCache = (key: string): ModelCacheMap => {
  const parsed = readStorageJson<Record<string, unknown>>(key, {});
  const now = Date.now();
  const fresh: ModelCacheMap = {};

  for (const [cacheKey, value] of Object.entries(parsed)) {
    if (!isRecord(value) || !Array.isArray(value.models)) continue;
    const cachedAt = Number(value.cachedAt);
    if (!Number.isFinite(cachedAt) || now - cachedAt > MODEL_CACHE_TTL_MS) continue;
    fresh[cacheKey] = {
      models: value.models as CloudModelOption[],
      cachedAt,
    };
  }

  return fresh;
};

interface ReasoningModelSelectorProps {
  useReasoningModel: boolean;
  setUseReasoningModel: (value: boolean) => void;
  reasoningModel: string;
  setReasoningModel: (model: string) => void;
  reasoningProvider: string;
  setReasoningProvider: (provider: string) => void;
  cloudReasoningBaseUrl: string;
  setCloudReasoningBaseUrl: (value: string) => void;
  customReasoningProtocol: CustomReasoningProtocol;
  setCustomReasoningProtocol: (protocol: CustomReasoningProtocol) => void;
  openaiApiKey: string;
  setOpenaiApiKey: (key: string) => void;
  openrouterApiKey: string;
  setOpenrouterApiKey: (key: string) => void;
  anthropicApiKey: string;
  setAnthropicApiKey: (key: string) => void;
  geminiApiKey: string;
  setGeminiApiKey: (key: string) => void;
  groqApiKey: string;
  setGroqApiKey: (key: string) => void;
  cerebrasApiKey: string;
  setCerebrasApiKey: (key: string) => void;
  customReasoningApiKey?: string;
  setCustomReasoningApiKey?: (key: string) => void;
  showAlertDialog: (dialog: { title: string; description: string }) => void;
}

export default function ReasoningModelSelector({
  useReasoningModel,
  setUseReasoningModel,
  reasoningModel,
  setReasoningModel,
  reasoningProvider,
  setReasoningProvider,
  cloudReasoningBaseUrl,
  setCloudReasoningBaseUrl,
  customReasoningProtocol,
  setCustomReasoningProtocol,
  openaiApiKey,
  setOpenaiApiKey,
  openrouterApiKey,
  setOpenrouterApiKey,
  anthropicApiKey,
  setAnthropicApiKey,
  geminiApiKey,
  setGeminiApiKey,
  groqApiKey,
  setGroqApiKey,
  cerebrasApiKey,
  setCerebrasApiKey,
  customReasoningApiKey = "",
  setCustomReasoningApiKey,
}: ReasoningModelSelectorProps) {
  const { t } = useTranslation();
  const [selectedMode, setSelectedMode] = useState<"cloud" | "local">("cloud");
  const [selectedCloudProvider, setSelectedCloudProvider] = useState("openai");
  const [selectedLocalProvider, setSelectedLocalProvider] = useState("qwen");
  const [customModelsCache, setCustomModelsCache] = useState<ModelCacheMap>(() =>
    readFreshModelCache(CUSTOM_MODELS_CACHE_KEY)
  );
  const [customModelsLoading, setCustomModelsLoading] = useState(false);
  const [customModelsError, setCustomModelsError] = useState<string | null>(null);
  const [providerModelsCache, setProviderModelsCache] = useState<ModelCacheMap>(() =>
    readFreshModelCache(PROVIDER_MODELS_CACHE_KEY)
  );
  const providerFetchState = useRef<Record<string, boolean | "done">>({});
  const [providerLoading, setProviderLoading] = useState<Record<string, boolean>>({});
  const [providerError, setProviderError] = useState<Record<string, string | null>>({});
  const [providerNotice, setProviderNotice] = useState<Record<string, string | null>>({});
  const [detectedCustomProtocol, setDetectedCustomProtocol] = useState<
    "chat" | "responses" | undefined
  >();

  const DEFAULT_PROVIDER_ENDPOINTS: Record<string, string> = useMemo(
    () => ({
      openai: "https://api.openai.com/v1",
      openrouter: "https://openrouter.ai/api/v1",
      anthropic: "https://api.anthropic.com/v1",
      gemini: "https://generativelanguage.googleapis.com/v1beta",
      groq: "https://api.groq.com/openai/v1",
      cerebras: API_ENDPOINTS.CEREBRAS_BASE,
      bedrock: "https://bedrock-runtime.us-east-1.amazonaws.com",
    }),
    []
  );

  const [providerEndpoints, setProviderEndpoints] = useState<Record<string, string>>(() => {
    try {
      const saved = localStorage.getItem("providerEndpoints");
      if (saved) return { ...DEFAULT_PROVIDER_ENDPOINTS, ...JSON.parse(saved) };
    } catch {
      /* ignore */
    }
    return { ...DEFAULT_PROVIDER_ENDPOINTS };
  });

  const [providerEndpointInputs, setProviderEndpointInputs] = useState<Record<string, string>>(
    () => ({
      ...DEFAULT_PROVIDER_ENDPOINTS,
      ...providerEndpoints,
    })
  );

  const setProviderNoticeMessage = useCallback((providerId: string, message: string | null) => {
    setProviderNotice((prev) => {
      if ((prev[providerId] || null) === message) return prev;
      return { ...prev, [providerId]: message };
    });
  }, []);

  const updateProviderEndpoint = useCallback((providerId: string, value: string) => {
    const normalized = normalizeBaseUrl(value) || value.trim();
    setProviderEndpoints((prev) => {
      const next = { ...prev, [providerId]: normalized };
      try {
        localStorage.setItem("providerEndpoints", JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    });
    setProviderEndpointInputs((prev) => ({ ...prev, [providerId]: normalized }));
    // Reset fetch state so next refresh uses new endpoint
    providerFetchState.current[providerId] = false;
  }, []);

  const getNormalizedProviderEndpoint = useCallback(
    (providerId: string, rawValue?: string | null) => {
      const candidate =
        rawValue ??
        providerEndpointInputs[providerId] ??
        providerEndpoints[providerId] ??
        DEFAULT_PROVIDER_ENDPOINTS[providerId] ??
        "";

      return (
        normalizeBaseUrl(candidate) ||
        String(candidate || "").trim() ||
        DEFAULT_PROVIDER_ENDPOINTS[providerId] ||
        ""
      );
    },
    [DEFAULT_PROVIDER_ENDPOINTS, providerEndpointInputs, providerEndpoints]
  );

  const alignGeminiEndpointForModel = useCallback(
    (modelId: string, endpointCandidate?: string) => {
      const currentEndpoint = getNormalizedProviderEndpoint("gemini", endpointCandidate);
      const requestEndpoint = getGeminiRequestBaseUrl(currentEndpoint) || currentEndpoint;

      if (requestEndpoint !== currentEndpoint) {
        updateProviderEndpoint("gemini", requestEndpoint);
        setProviderNoticeMessage("gemini", null);
        return requestEndpoint;
      }

      if (!isOfficialGoogleGeminiEndpoint(currentEndpoint)) {
        setProviderNoticeMessage("gemini", null);
        return requestEndpoint;
      }

      if (getOfficialGoogleGeminiApiVersion(currentEndpoint) !== "v1") {
        return currentEndpoint;
      }

      const modelLabel = modelId || "Gemini";
      const nextEndpoint = toOfficialGoogleGeminiV1BetaEndpoint(currentEndpoint);
      updateProviderEndpoint("gemini", nextEndpoint);
      setProviderNoticeMessage(
        "gemini",
        t("reasoning.gemini.autoSwitchedToBeta", {
          model: modelLabel,
          defaultValue:
            "Switched Gemini to v1beta for official Google generateContent compatibility.",
        })
      );
      return nextEndpoint;
    },
    [getNormalizedProviderEndpoint, setProviderNoticeMessage, t, updateProviderEndpoint]
  );

  // Bedrock-specific state
  const [bedrockAccessKeyId, setBedrockAccessKeyId] = useState(
    () => localStorage.getItem("bedrockAccessKeyId") || ""
  );
  const [bedrockSecretAccessKey, setBedrockSecretAccessKey] = useState(
    () => localStorage.getItem("bedrockSecretAccessKey") || ""
  );
  const [bedrockSessionToken, setBedrockSessionToken] = useState(
    () => localStorage.getItem("bedrockSessionToken") || ""
  );
  const [bedrockRegion, setBedrockRegion] = useState(
    () => localStorage.getItem("bedrockRegion") || "us-east-1"
  );

  const saveBedrockCredential = useCallback((key: string, value: string) => {
    localStorage.setItem(key, value);
    if (
      key === "bedrockAccessKeyId" ||
      key === "bedrockSecretAccessKey" ||
      key === "bedrockSessionToken"
    ) {
      void window.electronAPI?.saveBedrockCredential?.(key, value);
    }
  }, []);

  useEffect(() => {
    if (bedrockAccessKeyId && bedrockSecretAccessKey && bedrockSessionToken) {
      return;
    }
    let active = true;
    void window.electronAPI
      ?.getBedrockCredentials?.()
      .then((credentials) => {
        if (!active || !credentials) return;
        if (!bedrockAccessKeyId && credentials.bedrockAccessKeyId) {
          setBedrockAccessKeyId(credentials.bedrockAccessKeyId);
          localStorage.setItem("bedrockAccessKeyId", credentials.bedrockAccessKeyId);
        }
        if (!bedrockSecretAccessKey && credentials.bedrockSecretAccessKey) {
          setBedrockSecretAccessKey(credentials.bedrockSecretAccessKey);
          localStorage.setItem("bedrockSecretAccessKey", credentials.bedrockSecretAccessKey);
        }
        if (!bedrockSessionToken && credentials.bedrockSessionToken) {
          setBedrockSessionToken(credentials.bedrockSessionToken);
          localStorage.setItem("bedrockSessionToken", credentials.bedrockSessionToken);
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [bedrockAccessKeyId, bedrockSecretAccessKey, bedrockSessionToken]);

  useEffect(() => {
    const region = bedrockRegion.trim() || "us-east-1";
    const desiredEndpoint = `https://bedrock-runtime.${region}.amazonaws.com`;
    const currentEndpoint =
      normalizeBaseUrl(providerEndpointInputs.bedrock || providerEndpoints.bedrock) || "";
    const isGeneratedAwsEndpoint =
      !currentEndpoint ||
      /^https:\/\/bedrock-runtime\.[a-z0-9-]+\.amazonaws\.com$/i.test(currentEndpoint);

    if (isGeneratedAwsEndpoint && currentEndpoint !== desiredEndpoint) {
      updateProviderEndpoint("bedrock", desiredEndpoint);
    }
  }, [
    bedrockRegion,
    providerEndpointInputs.bedrock,
    providerEndpoints.bedrock,
    updateProviderEndpoint,
  ]);

  const loadBedrockModels = useCallback(
    async (force = false) => {
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
          sessionToken: bedrockSessionToken.trim() || undefined,
        });

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), MODEL_LIST_TIMEOUT_MS);
        const response = await fetch(signed.url, {
          method: "GET",
          headers: signed.headers,
          signal: controller.signal,
        }).finally(() => {
          clearTimeout(timeoutId);
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
            _created: isRecord(m) ? extractReleaseTimestamp(m) : 0,
          }));

        // Newest release first when timestamps are available; fallback to version-aware ID sorting.
        models.sort(compareModelsByRecency);

        if (models.length > 0) {
          setProviderModelsCache((prev) => ({
            ...prev,
            bedrock: { models, cachedAt: Date.now() },
          }));
          providerFetchState.current.bedrock = "done";
        } else {
          providerFetchState.current.bedrock = false;
        }
      } catch (error) {
        providerFetchState.current.bedrock = false;
        const message =
          (error as Error).name === "AbortError"
            ? "Model list request timed out after 15s"
            : (error as Error).message || "Failed to load Bedrock models";
        setProviderError((prev) => ({
          ...prev,
          bedrock: message,
        }));
      } finally {
        setProviderLoading((prev) => ({ ...prev, bedrock: false }));
      }
    },
    [bedrockAccessKeyId, bedrockRegion, bedrockSecretAccessKey, bedrockSessionToken]
  );

  const [customBaseInput, setCustomBaseInput] = useState(cloudReasoningBaseUrl);
  const [customModelInput, setCustomModelInput] = useState("");
  const lastLoadedBaseRef = useRef<string | null>(null);
  const pendingBaseRef = useRef<string | null>(null);
  const isMountedRef = useRef(true);

  useEffect(() => {
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const dispose = window.electronAPI?.onAppShuttingDown?.(() => {
      pendingBaseRef.current = null;
      if (!isMountedRef.current) return;
      setCustomModelsLoading(false);
      setCustomModelsError(null);
      setProviderLoading({});
      setProviderError({});
    });

    return () => {
      dispose?.();
    };
  }, []);

  useEffect(() => {
    setCustomBaseInput(cloudReasoningBaseUrl);
  }, [cloudReasoningBaseUrl]);

  useEffect(() => {
    try {
      localStorage.setItem(PROVIDER_MODELS_CACHE_KEY, JSON.stringify(providerModelsCache));
    } catch {
      /* ignore */
    }
  }, [providerModelsCache]);

  useEffect(() => {
    try {
      localStorage.setItem(CUSTOM_MODELS_CACHE_KEY, JSON.stringify(customModelsCache));
    } catch {
      /* ignore */
    }
  }, [customModelsCache]);

  const defaultOpenAIBase = useMemo(() => normalizeBaseUrl(API_ENDPOINTS.OPENAI_BASE), []);
  const normalizedCustomReasoningBase = useMemo(
    () => getEndpointBaseUrl(cloudReasoningBaseUrl),
    [cloudReasoningBaseUrl]
  );
  const latestReasoningBaseRef = useRef(normalizedCustomReasoningBase);

  const refreshDetectedCustomProtocol = useCallback(() => {
    if (!normalizedCustomReasoningBase) {
      setDetectedCustomProtocol(undefined);
      return;
    }

    setDetectedCustomProtocol(
      ReasoningService.getDetectedOpenAiPreference(normalizedCustomReasoningBase)
    );
  }, [normalizedCustomReasoningBase]);

  useEffect(() => {
    latestReasoningBaseRef.current = normalizedCustomReasoningBase;
  }, [normalizedCustomReasoningBase]);

  useEffect(() => {
    refreshDetectedCustomProtocol();
  }, [refreshDetectedCustomProtocol]);

  useEffect(() => {
    const handlePreferenceChanged = () => {
      refreshDetectedCustomProtocol();
    };
    window.addEventListener("openai-endpoint-preference-changed", handlePreferenceChanged);
    return () => {
      window.removeEventListener("openai-endpoint-preference-changed", handlePreferenceChanged);
    };
  }, [refreshDetectedCustomProtocol]);

  const hasCustomBase = normalizedCustomReasoningBase !== "";
  const effectiveReasoningBase = hasCustomBase ? normalizedCustomReasoningBase : defaultOpenAIBase;
  const customUsesGeminiGenerateContent =
    customReasoningProtocol === CUSTOM_GEMINI_GENERATE_CONTENT_PROTOCOL;
  const customGeminiEndpointInfo = useMemo(
    () =>
      customUsesGeminiGenerateContent
        ? getGeminiGenerateContentEndpointInfo(effectiveReasoningBase)
        : null,
    [customUsesGeminiGenerateContent, effectiveReasoningBase]
  );
  const customGeminiEndpointModelId = customGeminiEndpointInfo?.modelId || "";
  const customGeminiModelsUrl = useMemo(() => {
    if (!customUsesGeminiGenerateContent || !hasCustomBase || customGeminiEndpointInfo) return "";
    const geminiBase = getGeminiRequestBaseUrl(effectiveReasoningBase) || effectiveReasoningBase;
    return buildModelsUrl(geminiBase);
  }, [
    customUsesGeminiGenerateContent,
    hasCustomBase,
    customGeminiEndpointInfo,
    effectiveReasoningBase,
  ]);
  const customGeminiGenerateContentUrl = useMemo(() => {
    if (!customUsesGeminiGenerateContent || !hasCustomBase || !reasoningModel.trim()) return "";
    return buildGeminiGenerateContentUrl(effectiveReasoningBase, reasoningModel.trim());
  }, [customUsesGeminiGenerateContent, hasCustomBase, effectiveReasoningBase, reasoningModel]);

  const loadRemoteModels = useCallback(
    async (baseOverride?: string, force = false) => {
      const rawBase = (baseOverride ?? cloudReasoningBaseUrl) || "";
      const normalizedEndpoint = normalizeEndpointUrl(rawBase);
      const normalizedBase = getEndpointBaseUrl(normalizedEndpoint);

      if (!normalizedBase) {
        if (isMountedRef.current) {
          setCustomModelsLoading(false);
          setCustomModelsError(null);
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
      }

      let apiKey: string | undefined;

      try {
        // Use the custom reasoning API key for custom endpoints
        const keyFromState = customReasoningApiKey?.trim();
        apiKey = keyFromState && keyFromState.length > 0 ? keyFromState : undefined;

        if (!normalizedEndpoint.includes("://")) {
          if (isMountedRef.current && latestReasoningBaseRef.current === normalizedBase) {
            setCustomModelsError(t("reasoning.custom.endpointWithProtocol"));
            setCustomModelsLoading(false);
          }
          return;
        }

        if (!isSecureEndpoint(normalizedEndpoint)) {
          if (isMountedRef.current && latestReasoningBaseRef.current === normalizedBase) {
            setCustomModelsError(t("reasoning.custom.httpsRequired"));
            setCustomModelsLoading(false);
          }
          return;
        }

        if (customReasoningProtocol === CUSTOM_GEMINI_GENERATE_CONTENT_PROTOCOL) {
          const endpointInfo = getGeminiGenerateContentEndpointInfo(normalizedEndpoint);
          if (endpointInfo) {
            const model = {
              value: endpointInfo.modelId,
              label: endpointInfo.modelId,
              description: t("reasoning.custom.ownerLabel", {
                owner: t("reasoning.custom.providerName"),
              }),
              icon: undefined,
              ownedBy: undefined,
              invertInDark: false,
            } as CloudModelOption;
            if (isMountedRef.current && latestReasoningBaseRef.current === normalizedBase) {
              setCustomModelsCache((prev) => ({
                ...prev,
                [normalizedBase]: { models: [model], cachedAt: Date.now() },
              }));
              if (!reasoningModel || reasoningModel !== endpointInfo.modelId) {
                setReasoningModel(endpointInfo.modelId);
              }
              setCustomModelInput(endpointInfo.modelId);
              setCustomModelsError(null);
              lastLoadedBaseRef.current = normalizedBase;
            }
            return;
          }
        }

        const headers: Record<string, string> = {};
        if (apiKey) {
          if (customReasoningProtocol === CUSTOM_GEMINI_GENERATE_CONTENT_PROTOCOL) {
            headers["x-goog-api-key"] = apiKey;
          } else {
            headers.Authorization = `Bearer ${apiKey}`;
          }
        }

        const modelsUrl =
          customReasoningProtocol === CUSTOM_GEMINI_GENERATE_CONTENT_PROTOCOL
            ? buildModelsUrl(getGeminiRequestBaseUrl(normalizedEndpoint) || normalizedEndpoint)
            : buildModelsUrl(normalizedEndpoint);
        const response = await fetchModelsWithProxyFallback(modelsUrl, headers);

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

            // Prefer provider-published timestamps when available.
            const created = extractReleaseTimestamp(item);

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
              _created: created,
            } as CloudModelOption & { _created: number };
          })
          .filter(Boolean) as (CloudModelOption & { _created: number })[];

        // Newest release first, with robust fallbacks for providers that don't expose timestamps.
        mappedModels.sort(compareModelsByRecency);

        if (isMountedRef.current && latestReasoningBaseRef.current === normalizedBase) {
          setCustomModelsCache((prev) => ({
            ...prev,
            [normalizedBase]: { models: mappedModels, cachedAt: Date.now() },
          }));
          setCustomModelsError(null);
          lastLoadedBaseRef.current = normalizedBase;
        }
      } catch (error) {
        if (isMountedRef.current && latestReasoningBaseRef.current === normalizedBase) {
          if (isAppShuttingDownError(error)) {
            setCustomModelsError(null);
            return;
          }
          const message = (error as Error).message || t("reasoning.custom.unableToLoadModels");
          const unauthorized = /\b(401|403)\b/.test(message);
          if (unauthorized && !apiKey) {
            setCustomModelsError(t("reasoning.custom.endpointUnauthorized"));
          } else {
            setCustomModelsError(message);
          }
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
    [
      cloudReasoningBaseUrl,
      customReasoningApiKey,
      customReasoningProtocol,
      reasoningModel,
      setReasoningModel,
      t,
    ]
  );

  const customModelOptions = useMemo<CloudModelOption[]>(
    () =>
      normalizedCustomReasoningBase
        ? customModelsCache[normalizedCustomReasoningBase]?.models || []
        : [],
    [customModelsCache, normalizedCustomReasoningBase]
  );

  const trimmedCustomBase = customBaseInput.trim();
  const hasSavedCustomBase = Boolean((cloudReasoningBaseUrl || "").trim());
  const isCustomBaseDirty = trimmedCustomBase !== (cloudReasoningBaseUrl || "").trim();

  const displayedCustomModels = useMemo<CloudModelOption[]>(() => {
    if (isCustomBaseDirty) return [];
    return customModelOptions;
  }, [isCustomBaseDirty, customModelOptions]);

  const getCustomModelInputValue = useCallback(
    (modelId: string) => {
      const trimmedModelId = modelId.trim();
      if (!trimmedModelId) return "";
      if (customGeminiEndpointModelId && customGeminiEndpointModelId === trimmedModelId) {
        return trimmedModelId;
      }
      return displayedCustomModels.some((model) => model.value === trimmedModelId)
        ? ""
        : trimmedModelId;
    },
    [customGeminiEndpointModelId, displayedCustomModels]
  );

  useEffect(() => {
    if (selectedCloudProvider !== "custom") {
      setCustomModelInput("");
      return;
    }

    setCustomModelInput(getCustomModelInputValue(reasoningModel));
  }, [getCustomModelInputValue, reasoningModel, selectedCloudProvider]);

  const cloudProviderIds = useMemo(
    () => ["openai", "openrouter", "anthropic", "gemini", "groq", "cerebras", "bedrock", "custom"],
    []
  );
  const cloudProviders = useMemo(
    () =>
      cloudProviderIds.map((id) => ({
        id,
        name:
          id === "custom"
            ? t("reasoning.custom.providerName")
            : id === "bedrock"
              ? "AWS Bedrock"
              : REASONING_PROVIDERS[id as keyof typeof REASONING_PROVIDERS]?.name || id,
      })),
    [cloudProviderIds, t]
  );

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

  const selectedCloudGuideUrl = getProviderGuideUrl(selectedCloudProvider);

  const getProviderModelsUrl = useCallback(
    (providerId: string, apiKey?: string, endpointOverride?: string): string => {
      const rawBase =
        endpointOverride ||
        providerEndpoints[providerId] ||
        DEFAULT_PROVIDER_ENDPOINTS[providerId] ||
        "";
      const base = providerId === "gemini" ? getGeminiRequestBaseUrl(rawBase) || rawBase : rawBase;
      if (!base) return "";
      if (providerId === "gemini") {
        if (isOpenAiCompatibleGeminiEndpoint(base)) {
          return buildModelsUrl(base);
        }
        return `${base}/models${apiKey ? `?key=${apiKey}` : ""}`;
      }
      return `${base}/models`;
    },
    [providerEndpoints, DEFAULT_PROVIDER_ENDPOINTS]
  );

  const loadBuiltInProviderModels = useCallback(
    async (providerId: string, apiKey: string, force = false, endpointOverride?: string) => {
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
        const endpoint = getProviderModelsUrl(providerId, apiKey, endpointOverride);
        const headers: Record<string, string> = {};
        const rawBase =
          endpointOverride ||
          providerEndpoints[providerId] ||
          DEFAULT_PROVIDER_ENDPOINTS[providerId] ||
          "";
        const isGeminiOpenAiCompatible =
          providerId === "gemini" &&
          isOpenAiCompatibleGeminiEndpoint(getGeminiRequestBaseUrl(rawBase) || rawBase);

        if (providerId === "anthropic") {
          headers["x-api-key"] = apiKey;
          headers["anthropic-version"] = "2023-06-01";
        } else if (isGeminiOpenAiCompatible) {
          headers.Authorization = `Bearer ${apiKey}`;
        } else if (providerId !== "gemini") {
          // OpenAI, Groq, and other Bearer-token providers
          headers.Authorization = `Bearer ${apiKey}`;
        }

        if (!endpoint) return;

        const response = await fetchModelsWithProxyFallback(endpoint, headers);
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
            if (typeof item === "string")
              return {
                value: item,
                label: item,
                icon: iconUrl,
                invertInDark,
                _created: 0,
              } as CloudModelOption & { _created: number };
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

            const humanName = pickFirstString(
              item.name,
              item.display_name,
              item.title,
              item.displayName
            );
            const summary = pickFirstString(item.description, item.summary, item.details);
            const descriptionParts = [
              ...(humanName && humanName !== displayValue ? [humanName] : []),
              ...(summary && summary !== humanName ? [summary] : []),
            ];

            // Prefer provider-published timestamps when available.
            const created = extractReleaseTimestamp(item);

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

        // Newest release first, with version/date token fallback for providers without explicit timestamps.
        mappedModels.sort(compareModelsByRecency);

        if (mappedModels.length > 0) {
          if (isMountedRef.current) {
            setProviderModelsCache((prev) => ({
              ...prev,
              [providerId]: { models: mappedModels, cachedAt: Date.now() },
            }));
            providerFetchState.current[providerId] = "done";
            setProviderError((prev) => ({ ...prev, [providerId]: null }));
          }
        } else {
          providerFetchState.current[providerId] = false;
        }
      } catch (error) {
        providerFetchState.current[providerId] = false;
        if (isMountedRef.current) {
          if (isAppShuttingDownError(error)) {
            setProviderError((prev) => ({ ...prev, [providerId]: null }));
            return;
          }
          const message = (error as Error).message || t("reasoning.custom.unableToLoadModels");
          setProviderError((prev) => ({ ...prev, [providerId]: message }));
        }
      } finally {
        if (isMountedRef.current) {
          setProviderLoading((prev) => ({ ...prev, [providerId]: false }));
        }
      }
    },
    [DEFAULT_PROVIDER_ENDPOINTS, getProviderModelsUrl, providerEndpoints, t]
  );

  const handleRefreshProviderModels = useCallback(
    (providerId: string) => {
      const keys: Record<string, string> = {
        openai: openaiApiKey,
        openrouter: openrouterApiKey,
        anthropic: anthropicApiKey,
        gemini: geminiApiKey,
        groq: groqApiKey,
        cerebras: cerebrasApiKey,
      };
      let key = keys[providerId] || "";

      if (providerId === "gemini") {
        const rawEndpoint = providerEndpointInputs.gemini || providerEndpoints.gemini;
        if (getGeminiEndpointFamily(rawEndpoint) === "compatible") {
          key = customReasoningApiKey?.trim() || geminiApiKey?.trim() || "";
        }
      }
      if (!key) return;

      let endpointOverride: string | undefined;
      if (providerId === "gemini") {
        endpointOverride = alignGeminiEndpointForModel(
          reasoningModel,
          providerEndpointInputs.gemini || providerEndpoints.gemini
        );
      }

      loadBuiltInProviderModels(providerId, key, true, endpointOverride);
    },
    [
      alignGeminiEndpointForModel,
      openaiApiKey,
      openrouterApiKey,
      anthropicApiKey,
      customReasoningApiKey,
      geminiApiKey,
      groqApiKey,
      cerebrasApiKey,
      providerEndpointInputs.gemini,
      providerEndpoints.gemini,
      reasoningModel,
      loadBuiltInProviderModels,
    ]
  );

  const handleProviderEndpointBlur = useCallback(
    (providerId: string) => {
      const input = (providerEndpointInputs[providerId] || "").trim();
      const current = providerEndpoints[providerId] || "";

      if (providerId === "gemini") {
        const normalizedInput = normalizeBaseUrl(input) || input;
        const alignedEndpoint = alignGeminiEndpointForModel(
          reasoningModel,
          normalizedInput || current
        );
        if (alignedEndpoint !== (normalizedInput || current)) {
          return;
        }
        setProviderNoticeMessage("gemini", null);
      }

      if (input && input !== current) {
        updateProviderEndpoint(providerId, input);
      }
    },
    [
      alignGeminiEndpointForModel,
      providerEndpointInputs,
      providerEndpoints,
      reasoningModel,
      setProviderNoticeMessage,
      updateProviderEndpoint,
    ]
  );

  const selectedCloudModels = useMemo<CloudModelOption[]>(() => {
    if (selectedCloudProvider === "custom") {
      const models = [...displayedCustomModels];
      if (reasoningModel && !models.some((model) => model.value === reasoningModel)) {
        models.unshift({
          value: reasoningModel,
          label: reasoningModel,
          description: t("reasoning.custom.ownerLabel", {
            owner: t("reasoning.custom.providerName"),
          }),
        });
      }
      return prioritizeSelectedModel(models, reasoningModel);
    }

    const dynamicModels = providerModelsCache[selectedCloudProvider]?.models;
    const hardcodedProvider =
      REASONING_PROVIDERS[selectedCloudProvider as keyof typeof REASONING_PROVIDERS];
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
        const hardcoded = hardcodedProvider.models.find((hm) => hm.value === m.value);
        if (hardcoded && !m.description) {
          return {
            ...m,
            description: hardcoded.descriptionKey
              ? t(hardcoded.descriptionKey, { defaultValue: hardcoded.description })
              : hardcoded.description,
          };
        }
        return m;
      });
    }

    // Always ensure the currently selected model is included so it doesn't break UI if missing
    if (reasoningModel && !baseModels.some((m) => m.value === reasoningModel)) {
      baseModels.unshift({
        value: reasoningModel,
        label: reasoningModel,
        description: t("reasoning.custom.ownerLabel", { owner: selectedCloudProvider }),
        icon: iconUrl,
        invertInDark,
      });
    }

    return prioritizeSelectedModel(baseModels, reasoningModel);
  }, [selectedCloudProvider, displayedCustomModels, providerModelsCache, reasoningModel, t]);

  const geminiEndpointInput = useMemo(
    () =>
      providerEndpointInputs.gemini ||
      providerEndpoints.gemini ||
      DEFAULT_PROVIDER_ENDPOINTS.gemini,
    [DEFAULT_PROVIDER_ENDPOINTS.gemini, providerEndpointInputs.gemini, providerEndpoints.gemini]
  );

  const geminiEndpointVersion = useMemo(
    () => getOfficialGoogleGeminiApiVersion(geminiEndpointInput),
    [geminiEndpointInput]
  );
  const geminiOfficialEndpointSelected = useMemo(
    () => isOfficialGoogleGeminiEndpoint(geminiEndpointInput),
    [geminiEndpointInput]
  );

  const geminiEndpointDirty =
    (providerEndpointInputs.gemini || "").trim() !== (providerEndpoints.gemini || "").trim();
  const geminiOfficialProviderSelected =
    selectedMode === "cloud" && selectedCloudProvider === "gemini";
  const geminiOfficialEndpointMismatch =
    geminiOfficialProviderSelected &&
    geminiOfficialEndpointSelected &&
    geminiEndpointVersion === "v1";

  const handleApplyCustomBase = useCallback(
    (refresh = false) => {
      const trimmedBase = customBaseInput.trim();
      const normalized = trimmedBase ? normalizeEndpointUrl(trimmedBase) : trimmedBase;
      setCustomBaseInput(normalized);
      setCloudReasoningBaseUrl(normalized);
      if (customReasoningProtocol === CUSTOM_GEMINI_GENERATE_CONTENT_PROTOCOL) {
        const endpointInfo = getGeminiGenerateContentEndpointInfo(normalized);
        if (endpointInfo?.modelId) {
          setReasoningModel(endpointInfo.modelId);
          setCustomModelInput(endpointInfo.modelId);
        }
      }
      lastLoadedBaseRef.current = null;
      pendingBaseRef.current = null;
      if (refresh) {
        loadRemoteModels(normalized, true);
      }
    },
    [
      customBaseInput,
      customReasoningProtocol,
      setCloudReasoningBaseUrl,
      setReasoningModel,
      loadRemoteModels,
    ]
  );

  const handleBaseUrlBlur = useCallback(() => {
    const trimmedBase = customBaseInput.trim();
    if (!trimmedBase) return;

    if (trimmedBase !== (cloudReasoningBaseUrl || "").trim()) {
      handleApplyCustomBase(false);
    }
  }, [customBaseInput, cloudReasoningBaseUrl, handleApplyCustomBase]);

  const handleRefreshCustomModels = useCallback(() => {
    if (isCustomBaseDirty) {
      handleApplyCustomBase(true);
      return;
    }
    if (!trimmedCustomBase) return;
    loadRemoteModels(undefined, true);
  }, [handleApplyCustomBase, isCustomBaseDirty, trimmedCustomBase, loadRemoteModels]);

  const handleResetDetectedProtocol = useCallback(() => {
    if (!normalizedCustomReasoningBase) return;
    ReasoningService.clearDetectedOpenAiPreference(normalizedCustomReasoningBase);
    setDetectedCustomProtocol(undefined);
  }, [normalizedCustomReasoningBase]);

  useEffect(() => {
    const localProviderIds = localProviders.map((p) => p.id);
    const legacyLocalProvider = isLocalReasoningProviderId(reasoningProvider)
      ? reasoningProvider.trim().toLowerCase()
      : "";
    const storedLocalProvider = localStorage.getItem(LOCAL_REASONING_PROVIDER_STORAGE_KEY) || "";
    const modelLocalProvider = getLocalReasoningProviderIdForModel(reasoningModel) || "";
    const fallbackLocalProvider = localProviderIds[0] || "qwen";
    const resolveLocalProvider = (candidate: string): string =>
      localProviderIds.includes(candidate) ? candidate : "";
    const preferredLocalProvider =
      resolveLocalProvider(legacyLocalProvider) ||
      resolveLocalProvider(storedLocalProvider) ||
      resolveLocalProvider(modelLocalProvider) ||
      fallbackLocalProvider;

    if (legacyLocalProvider) {
      setSelectedMode("local");
      setSelectedLocalProvider(preferredLocalProvider);
      localStorage.setItem(LOCAL_REASONING_PROVIDER_STORAGE_KEY, preferredLocalProvider);
      setReasoningProvider("local");
    } else if (reasoningProvider === "local") {
      setSelectedMode("local");
      setSelectedLocalProvider(preferredLocalProvider);
    } else if (cloudProviderIds.includes(reasoningProvider)) {
      setSelectedMode("cloud");
      setSelectedCloudProvider(reasoningProvider);
    }
  }, [cloudProviderIds, localProviders, reasoningModel, reasoningProvider, setReasoningProvider]);

  useEffect(() => {
    if (selectedMode !== "cloud" || selectedCloudProvider !== "gemini" || !reasoningModel) return;
    if (geminiEndpointDirty) return;
    alignGeminiEndpointForModel(reasoningModel, providerEndpoints.gemini);
  }, [
    alignGeminiEndpointForModel,
    geminiEndpointDirty,
    providerEndpoints.gemini,
    reasoningModel,
    selectedCloudProvider,
    selectedMode,
  ]);

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
      setReasoningProvider(selectedCloudProvider);

      if (selectedCloudProvider === "custom") {
        setCustomBaseInput(cloudReasoningBaseUrl);
        lastLoadedBaseRef.current = null;
        pendingBaseRef.current = null;

        if (customModelOptions.length > 0) {
          setReasoningModel(customModelOptions[0].value);
          setCustomModelInput("");
        }
        return;
      }

      const provider =
        REASONING_PROVIDERS[selectedCloudProvider as keyof typeof REASONING_PROVIDERS];
      if (provider?.models?.length > 0) {
        setReasoningModel(provider.models[0].value);
      }
    } else {
      setReasoningProvider("local");
      localStorage.setItem(LOCAL_REASONING_PROVIDER_STORAGE_KEY, selectedLocalProvider);
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
    setReasoningProvider(provider);

    const lastModel = localStorage.getItem(`chordvox_last_model_${provider}`);

    if (provider === "custom") {
      setCustomBaseInput(cloudReasoningBaseUrl);
      lastLoadedBaseRef.current = null;
      pendingBaseRef.current = null;

      if (lastModel) {
        setReasoningModel(lastModel);
        setCustomModelInput(getCustomModelInputValue(lastModel));
      } else if (customModelOptions.length > 0) {
        setReasoningModel(customModelOptions[0].value);
        setCustomModelInput("");
      }
      return;
    }

    if (provider === "bedrock") {
      const cachedModels = providerModelsCache.bedrock?.models;
      if (lastModel) {
        setReasoningModel(lastModel);
      } else if (cachedModels?.length > 0) {
        setReasoningModel(cachedModels[0].value);
      }
      return;
    }

    if (lastModel) {
      setReasoningModel(lastModel);
      if (provider === "gemini") {
        alignGeminiEndpointForModel(lastModel, providerEndpoints.gemini);
      }
      return;
    }

    const providerData = REASONING_PROVIDERS[provider as keyof typeof REASONING_PROVIDERS];
    const cachedModels = providerModelsCache[provider]?.models;
    const nextModel = cachedModels?.[0]?.value || providerData?.models?.[0]?.value || "";
    if (cachedModels?.length > 0) {
      setReasoningModel(cachedModels[0].value);
    } else if (providerData?.models?.length > 0) {
      setReasoningModel(providerData.models[0].value);
    }
    if (provider === "gemini" && nextModel) {
      alignGeminiEndpointForModel(nextModel, providerEndpoints.gemini);
    }
  };

  const handleLocalProviderChange = async (providerId: string) => {
    setSelectedLocalProvider(providerId);
    setReasoningProvider("local");
    localStorage.setItem(LOCAL_REASONING_PROVIDER_STORAGE_KEY, providerId);

    const downloaded = await loadDownloadedModels();
    const provider = localProviders.find((p) => p.id === providerId);
    const models = provider?.models ?? [];

    const lastModel = localStorage.getItem(`chordvox_last_model_local_${providerId}`);

    if (models.length > 0) {
      if (lastModel && models.some((m) => m.id === lastModel && downloaded.has(m.id))) {
        setReasoningModel(lastModel);
      } else {
        const firstDownloaded = models.find((m) => downloaded.has(m.id));
        if (firstDownloaded) {
          setReasoningModel(firstDownloaded.id);
        } else {
          setReasoningModel("");
        }
      }
    }
  };

  const handleModelSelect = useCallback(
    (modelId: string) => {
      if (selectedMode === "cloud" && selectedCloudProvider === "gemini") {
        alignGeminiEndpointForModel(
          modelId,
          providerEndpointInputs.gemini || providerEndpoints.gemini
        );
      }
      if (selectedMode === "cloud" && selectedCloudProvider === "custom") {
        setCustomModelInput("");
      }
      setReasoningModel(modelId);
      if (selectedMode === "cloud") {
        localStorage.setItem(`chordvox_last_model_${selectedCloudProvider}`, modelId);
      } else {
        localStorage.setItem(`chordvox_last_model_local_${selectedLocalProvider}`, modelId);
      }
    },
    [
      alignGeminiEndpointForModel,
      providerEndpointInputs.gemini,
      providerEndpoints.gemini,
      setReasoningModel,
      selectedMode,
      selectedCloudProvider,
      selectedLocalProvider,
    ]
  );

  const handleCustomModelInputChange = useCallback(
    (value: string) => {
      setCustomModelInput(value);
      const modelId = value.trim();
      setReasoningModel(modelId);
      if (modelId) {
        localStorage.setItem("chordvox_last_model_custom", modelId);
      } else {
        localStorage.removeItem("chordvox_last_model_custom");
      }
    },
    [setReasoningModel]
  );

  const selectedReasoningLabel = useReasoningModel ? t("common.active") : t("common.selected");
  const selectedReasoningTone = useReasoningModel ? "active" : "selected";

  return (
    <div className="space-y-4">
      <ProcessingModeSelector value={selectedMode} onChange={handleModeChange} />

      {selectedMode === "cloud" ? (
        <div className="space-y-2">
          <div className="border border-border rounded-lg overflow-hidden">
            <ProviderTabs
              providers={cloudProviders}
              selectedId={selectedCloudProvider}
              onSelect={handleCloudProviderChange}
              colorScheme="indigo"
              distribution="balanced"
              balancedMaxColumns={4}
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
                      name="customReasoningEndpoint"
                      autoComplete="off"
                      autoCapitalize="none"
                      spellCheck={false}
                      inputMode="url"
                      aria-label={t("reasoning.custom.endpointTitle")}
                      value={customBaseInput}
                      onChange={(event) => setCustomBaseInput(event.target.value)}
                      onBlur={handleBaseUrlBlur}
                      placeholder={
                        customUsesGeminiGenerateContent
                          ? "https://server/v1beta or https://server/v1beta/models/model:generateContent"
                          : "https://api.openai.com/v1 or https://server/v1/chat/completions"
                      }
                      className="text-sm"
                    />
                    <p className="text-xs text-muted-foreground">
                      {customUsesGeminiGenerateContent ? (
                        <>
                          {t("reasoning.custom.geminiEndpointHint", {
                            defaultValue:
                              "Use a Gemini-compatible base URL, or paste a full generateContent endpoint.",
                          })}
                        </>
                      ) : (
                        <>
                          {t("reasoning.custom.endpointExamples")}{" "}
                          <code className="text-primary">http://localhost:11434/v1</code>{" "}
                          {t("reasoning.custom.ollama")},{" "}
                          <code className="text-primary">http://localhost:8080/v1</code>{" "}
                          {t("reasoning.custom.localAi")}.
                        </>
                      )}
                    </p>
                  </div>

                  {/* 2. API Key - SECOND */}
                  <div className="space-y-2 pt-3">
                    <h4 className="font-medium text-foreground">
                      {t("reasoning.custom.apiKeyOptional")}
                    </h4>
                    <ApiKeyInput
                      apiKey={customReasoningApiKey}
                      setApiKey={setCustomReasoningApiKey || (() => {})}
                      provider="custom"
                      label=""
                      ariaLabel={t("reasoning.custom.apiKeyOptional")}
                      helpText={
                        customUsesGeminiGenerateContent
                          ? t("reasoning.custom.apiKeyHelpGemini", {
                              defaultValue:
                                "Optional. Sent as x-goog-api-key for Gemini-compatible endpoints.",
                            })
                          : t("reasoning.custom.apiKeyHelp")
                      }
                    />
                  </div>

                  <div className="space-y-2 pt-3">
                    <h4 className="font-medium text-foreground">
                      {t("reasoning.custom.protocolTitle", { defaultValue: "Protocol" })}
                    </h4>
                    <Select
                      value={customReasoningProtocol}
                      onValueChange={(value) => {
                        const nextProtocol = value as CustomReasoningProtocol;
                        setCustomReasoningProtocol(nextProtocol);
                        if (nextProtocol === CUSTOM_GEMINI_GENERATE_CONTENT_PROTOCOL) {
                          const endpointInfo = getGeminiGenerateContentEndpointInfo(
                            customBaseInput.trim()
                          );
                          if (endpointInfo?.modelId) {
                            setReasoningModel(endpointInfo.modelId);
                          }
                        }
                      }}
                    >
                      <SelectTrigger
                        aria-label={t("reasoning.custom.protocolTitle", {
                          defaultValue: "Protocol",
                        })}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="auto">
                          {t("reasoning.custom.protocolAuto", {
                            defaultValue: "Auto (Recommended)",
                          })}
                        </SelectItem>
                        <SelectItem value="chat">
                          {t("reasoning.custom.protocolChat", {
                            defaultValue: "Chat Completions",
                          })}
                        </SelectItem>
                        <SelectItem value="responses">
                          {t("reasoning.custom.protocolResponses", {
                            defaultValue: "Responses",
                          })}
                        </SelectItem>
                        <SelectItem value={CUSTOM_GEMINI_GENERATE_CONTENT_PROTOCOL}>
                          {t("reasoning.custom.protocolGeminiGenerateContent", {
                            defaultValue: "Gemini generateContent",
                          })}
                        </SelectItem>
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">
                      {t("reasoning.custom.protocolHelp", {
                        defaultValue:
                          "Auto remembers which protocol works for each endpoint. Force Chat Completions or Responses only when a provider needs it.",
                      })}
                    </p>
                    {customReasoningProtocol === "auto" && detectedCustomProtocol && (
                      <div className="flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
                        <p className="text-xs text-muted-foreground">
                          {t("reasoning.custom.detectedProtocolHelp", {
                            protocol:
                              detectedCustomProtocol === "chat"
                                ? t("reasoning.custom.protocolChat", {
                                    defaultValue: "Chat Completions",
                                  })
                                : t("reasoning.custom.protocolResponses", {
                                    defaultValue: "Responses",
                                  }),
                            defaultValue:
                              "Auto currently remembers {{protocol}} for this endpoint.",
                          })}
                        </p>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={handleResetDetectedProtocol}
                          className="shrink-0 text-xs"
                        >
                          {t("reasoning.custom.resetDetectedProtocol", {
                            defaultValue: "Reset detected protocol",
                          })}
                        </Button>
                      </div>
                    )}
                  </div>

                  <div className="space-y-2 pt-3">
                    <h4 className="font-medium text-foreground">
                      {t("reasoning.custom.modelIdTitle", {
                        defaultValue: "Model ID",
                      })}
                    </h4>
                    <Input
                      name="customReasoningModelId"
                      autoComplete="off"
                      autoCapitalize="none"
                      spellCheck={false}
                      aria-label={t("reasoning.custom.modelIdTitle", {
                        defaultValue: "Model ID",
                      })}
                      value={customModelInput}
                      onChange={(event) => handleCustomModelInputChange(event.target.value)}
                      placeholder={customUsesGeminiGenerateContent ? "gemini-3-flash" : "model-id"}
                      className="text-sm"
                    />
                    <p className="text-xs text-muted-foreground">
                      {customUsesGeminiGenerateContent
                        ? t("reasoning.custom.geminiModelIdHint", {
                            defaultValue:
                              "Required when you enter a base URL. Full generateContent URLs fill this automatically.",
                          })
                        : t("reasoning.custom.modelIdHint", {
                            defaultValue:
                              "Use this when the endpoint supports a model that is not listed below.",
                          })}
                    </p>
                  </div>

                  {/* 4. Model Selection - FOURTH */}
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
                      {customUsesGeminiGenerateContent && customGeminiEndpointInfo ? (
                        t("reasoning.custom.fullEndpointModelsHint", {
                          defaultValue:
                            "Full endpoint mode skips model-list loading and calls the configured endpoint directly.",
                        })
                      ) : (
                        <>
                          {t("reasoning.custom.queryPrefix")}{" "}
                          <code>
                            {customUsesGeminiGenerateContent
                              ? customGeminiModelsUrl
                              : hasCustomBase
                                ? `${effectiveReasoningBase}/models`
                                : `${defaultOpenAIBase}/models`}
                          </code>{" "}
                          {t("reasoning.custom.querySuffix")}
                        </>
                      )}
                    </p>
                    {customUsesGeminiGenerateContent && customGeminiGenerateContentUrl && (
                      <p className="text-xs text-muted-foreground">
                        {t("reasoning.custom.geminiRequestPrefix", {
                          defaultValue: "Generation requests will call",
                        })}{" "}
                        <code>{customGeminiGenerateContentUrl}</code>
                      </p>
                    )}
                    {isCustomBaseDirty && (
                      <p className="text-xs text-primary">
                        {t("reasoning.custom.modelsReloadHint")}
                      </p>
                    )}
                    {!hasCustomBase && (
                      <p className="text-xs text-warning">{t("reasoning.custom.enterEndpoint")}</p>
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
                          customModelOptions.length === 0 &&
                          !reasoningModel.trim() &&
                          !(customUsesGeminiGenerateContent && customGeminiEndpointInfo) && (
                            <p className="text-xs text-warning">{t("reasoning.custom.noModels")}</p>
                          )}
                      </>
                    )}
                    <ModelCardList
                      key={`cloud-models-${selectedCloudProvider}`}
                      models={selectedCloudModels}
                      selectedModel={reasoningModel}
                      onModelSelect={handleModelSelect}
                      enableSearch
                      noSearchResultsText={t("common.noMatchingModels")}
                      selectedLabel={selectedReasoningLabel}
                      selectedTone={selectedReasoningTone}
                    />
                  </div>
                </>
              ) : selectedCloudProvider === "bedrock" ? (
                <>
                  {/* Bedrock: Access Key ID */}
                  <div className="space-y-2">
                    <div className="flex items-baseline justify-between">
                      <h4 className="text-sm font-medium text-foreground">
                        {t("reasoning.custom.accessKeyId")}
                      </h4>
                      <a
                        href={selectedCloudGuideUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={createExternalLinkHandler(selectedCloudGuideUrl)}
                        className="text-xs text-link underline decoration-link/30 hover:decoration-link/60 cursor-pointer transition-colors"
                      >
                        {t("reasoning.getApiKey")}
                      </a>
                    </div>
                    <ApiKeyInput
                      name="bedrockAccessKeyId"
                      apiKey={bedrockAccessKeyId}
                      setApiKey={(value) => {
                        setBedrockAccessKeyId(value);
                        saveBedrockCredential("bedrockAccessKeyId", value);
                      }}
                      placeholder="AKIA..."
                      label=""
                      ariaLabel={t("reasoning.custom.accessKeyId")}
                      helpText=""
                    />
                  </div>

                  {/* Bedrock: Secret Access Key */}
                  <div className="space-y-2 pt-2">
                    <h4 className="text-sm font-medium text-foreground">
                      {t("reasoning.custom.secretAccessKey")}
                    </h4>
                    <ApiKeyInput
                      name="bedrockSecretAccessKey"
                      apiKey={bedrockSecretAccessKey}
                      setApiKey={(value) => {
                        setBedrockSecretAccessKey(value);
                        saveBedrockCredential("bedrockSecretAccessKey", value);
                      }}
                      placeholder="wJalr..."
                      label=""
                      ariaLabel={t("reasoning.custom.secretAccessKey")}
                      helpText=""
                    />
                  </div>

                  {/* Bedrock: Session Token (required for temporary AWS credentials) */}
                  <div className="space-y-2 pt-2">
                    <h4 className="text-sm font-medium text-foreground">
                      {t("reasoning.custom.sessionToken")}
                    </h4>
                    <ApiKeyInput
                      name="bedrockSessionToken"
                      apiKey={bedrockSessionToken}
                      setApiKey={(value) => {
                        setBedrockSessionToken(value);
                        saveBedrockCredential("bedrockSessionToken", value);
                      }}
                      placeholder="IQoJb3JpZ2luX2Vj..."
                      label=""
                      ariaLabel={t("reasoning.custom.sessionToken")}
                      helpText={t("reasoning.custom.sessionTokenHelp")}
                    />
                  </div>

                  {/* Bedrock: Region */}
                  <div className="space-y-2 pt-2">
                    <h4 className="text-sm font-medium text-foreground">
                      {t("reasoning.custom.region")}
                    </h4>
                    <Input
                      name="bedrockRegion"
                      autoComplete="off"
                      autoCapitalize="none"
                      spellCheck={false}
                      aria-label={t("reasoning.custom.region")}
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
                      name="bedrockEndpoint"
                      autoComplete="off"
                      autoCapitalize="none"
                      spellCheck={false}
                      inputMode="url"
                      aria-label={t("reasoning.custom.endpointTitle")}
                      value={providerEndpointInputs.bedrock || ""}
                      onChange={(e) =>
                        setProviderEndpointInputs((prev) => ({
                          ...prev,
                          bedrock: e.target.value,
                        }))
                      }
                      onBlur={() => handleProviderEndpointBlur("bedrock")}
                      placeholder={`https://bedrock-runtime.${bedrockRegion || "us-east-1"}.amazonaws.com`}
                      className="text-sm"
                    />
                    <p className="text-xs text-muted-foreground">
                      {t("reasoning.custom.bedrockEndpointHint")}
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
                        disabled={
                          providerLoading.bedrock || !bedrockAccessKeyId || !bedrockSecretAccessKey
                        }
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
                      key={`cloud-models-${selectedCloudProvider}`}
                      models={selectedCloudModels}
                      selectedModel={reasoningModel}
                      onModelSelect={handleModelSelect}
                      enableSearch
                      noSearchResultsText={t("common.noMatchingModels")}
                      selectedLabel={selectedReasoningLabel}
                      selectedTone={selectedReasoningTone}
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
                          href={selectedCloudGuideUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={createExternalLinkHandler(selectedCloudGuideUrl)}
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

                  {selectedCloudProvider === "openrouter" && (
                    <div className="space-y-2">
                      <div className="flex items-baseline justify-between">
                        <h4 className="font-medium text-foreground">{t("common.apiKey")}</h4>
                        <a
                          href={selectedCloudGuideUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={createExternalLinkHandler(selectedCloudGuideUrl)}
                          className="text-xs text-link underline decoration-link/30 hover:decoration-link/60 cursor-pointer transition-colors"
                        >
                          {t("reasoning.getApiKey")}
                        </a>
                      </div>
                      <ApiKeyInput
                        apiKey={openrouterApiKey}
                        setApiKey={setOpenrouterApiKey}
                        placeholder="sk-or-..."
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
                          href={selectedCloudGuideUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={createExternalLinkHandler(selectedCloudGuideUrl)}
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
                          href={selectedCloudGuideUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={createExternalLinkHandler(selectedCloudGuideUrl)}
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
                          href={selectedCloudGuideUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={createExternalLinkHandler(selectedCloudGuideUrl)}
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

                  {selectedCloudProvider === "cerebras" && (
                    <div className="space-y-2">
                      <div className="flex items-baseline justify-between">
                        <h4 className="font-medium text-foreground">{t("common.apiKey")}</h4>
                        <a
                          href={selectedCloudGuideUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={createExternalLinkHandler(selectedCloudGuideUrl)}
                          className="text-xs text-link underline decoration-link/30 hover:decoration-link/60 cursor-pointer transition-colors"
                        >
                          {t("reasoning.getApiKey")}
                        </a>
                      </div>
                      <ApiKeyInput
                        apiKey={cerebrasApiKey}
                        setApiKey={setCerebrasApiKey}
                        provider="cerebras"
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
                      name={`${selectedCloudProvider}Endpoint`}
                      autoComplete="off"
                      autoCapitalize="none"
                      spellCheck={false}
                      inputMode="url"
                      aria-label={t("reasoning.custom.endpointTitle")}
                      value={providerEndpointInputs[selectedCloudProvider] || ""}
                      onChange={(e) => {
                        setProviderEndpointInputs((prev) => ({
                          ...prev,
                          [selectedCloudProvider]: e.target.value,
                        }));
                        if (selectedCloudProvider === "gemini") {
                          setProviderNoticeMessage("gemini", null);
                        }
                      }}
                      onBlur={() => handleProviderEndpointBlur(selectedCloudProvider)}
                      placeholder={DEFAULT_PROVIDER_ENDPOINTS[selectedCloudProvider] || ""}
                      className="text-sm"
                    />
                    {selectedCloudProvider === "gemini" && (
                      <>
                        {geminiOfficialEndpointSelected && (
                          <p className="text-xs text-muted-foreground">
                            {t("reasoning.gemini.endpointHint", {
                              defaultValue:
                                "Gemini tip: official Google generateContent should use v1beta for ChordVox AI refinement.",
                            })}
                          </p>
                        )}
                        {geminiOfficialEndpointMismatch ? (
                          <p className="text-xs text-warning">
                            {t("reasoning.gemini.previewEndpointMismatch", {
                              model: reasoningModel,
                              defaultValue:
                                "This official Google endpoint is on v1. Leaving this field or refreshing models will switch Gemini back to v1beta.",
                            })}
                          </p>
                        ) : (
                          providerNotice.gemini && (
                            <p className="text-xs text-primary">{providerNotice.gemini}</p>
                          )
                        )}
                      </>
                    )}
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
                            openrouter: openrouterApiKey,
                            anthropic: anthropicApiKey,
                            gemini: geminiApiKey,
                            groq: groqApiKey,
                            cerebras: cerebrasApiKey,
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
                      <p className="text-xs text-primary">{t("reasoning.custom.fetchingModels")}</p>
                    )}
                    {providerError[selectedCloudProvider] && (
                      <p className="text-xs text-destructive">
                        {providerError[selectedCloudProvider]}
                      </p>
                    )}
                    <ModelCardList
                      key={`cloud-models-${selectedCloudProvider}`}
                      models={selectedCloudModels}
                      selectedModel={reasoningModel}
                      onModelSelect={handleModelSelect}
                      enableSearch
                      noSearchResultsText={t("common.noMatchingModels")}
                      selectedLabel={selectedReasoningLabel}
                      selectedTone={selectedReasoningTone}
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
          onModelSelect={handleModelSelect}
          onProviderSelect={handleLocalProviderChange}
          modelType="llm"
          colorScheme="purple"
          onDownloadComplete={loadDownloadedModels}
          selectedLabel={selectedReasoningLabel}
          selectedTone={selectedReasoningTone}
        />
      )}
    </div>
  );
}
