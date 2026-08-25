import { useSyncExternalStore } from "react";
import type { TranscriptionItem } from "../types/electron";

type Listener = () => void;

const listeners = new Set<Listener>();
let transcriptions: TranscriptionItem[] = [];
let hasBoundIpcListeners = false;
const DEFAULT_LIMIT = 50;
let currentLimit = DEFAULT_LIMIT;
let loadSequence = 0;

export interface TranscriptionHistoryMeta {
  hasMore: boolean;
  totalCount: number;
  isLoadingMore: boolean;
  nextCursor: string | null;
}

let historyMeta: TranscriptionHistoryMeta = {
  hasMore: false,
  totalCount: 0,
  isLoadingMore: false,
  nextCursor: null,
};

const emit = () => {
  listeners.forEach((listener) => listener());
};

const subscribe = (listener: Listener) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

const getSnapshot = () => transcriptions;
const getMetaSnapshot = () => historyMeta;

function setHistoryMeta(patch: Partial<TranscriptionHistoryMeta>) {
  historyMeta = { ...historyMeta, ...patch };
  emit();
}

function ensureIpcListeners() {
  if (hasBoundIpcListeners || typeof window === "undefined") {
    return;
  }

  const disposers: Array<() => void> = [];

  if (window.electronAPI?.onTranscriptionAdded) {
    const dispose = window.electronAPI.onTranscriptionAdded((item) => {
      if (item) {
        addTranscription(item);
      }
    });
    if (typeof dispose === "function") {
      disposers.push(dispose);
    }
  }

  if (window.electronAPI?.onTranscriptionDeleted) {
    const dispose = window.electronAPI.onTranscriptionDeleted(({ id }) => {
      removeTranscription(id);
    });
    if (typeof dispose === "function") {
      disposers.push(dispose);
    }
  }

  if (window.electronAPI?.onTranscriptionUpdated) {
    const dispose = window.electronAPI.onTranscriptionUpdated(({ id, patch }) => {
      updateTranscription(id, patch);
    });
    if (typeof dispose === "function") {
      disposers.push(dispose);
    }
  }

  if (window.electronAPI?.onTranscriptionsCleared) {
    const dispose = window.electronAPI.onTranscriptionsCleared(() => {
      clearTranscriptions();
    });
    if (typeof dispose === "function") {
      disposers.push(dispose);
    }
  }

  hasBoundIpcListeners = true;

  window.addEventListener("beforeunload", () => {
    disposers.forEach((dispose) => dispose());
  });
}

export async function initializeTranscriptions(limit = DEFAULT_LIMIT) {
  currentLimit = limit;
  ensureIpcListeners();
  const sequence = ++loadSequence;
  const result = await window.electronAPI.queryTranscriptionHistory({
    requestKey: "history-store",
    limit,
    offset: 0,
    cursor: null,
  });
  if (sequence !== loadSequence || result?.cancelled) {
    return transcriptions;
  }
  const items = result?.items || [];
  transcriptions = items;
  historyMeta = {
    hasMore: result?.hasMore === true,
    totalCount: Math.max(items.length, Number(result?.totalCount) || 0),
    isLoadingMore: false,
    nextCursor: result?.nextCursor || null,
  };
  emit();
  return items;
}

export async function loadMoreTranscriptions(pageSize = DEFAULT_LIMIT) {
  if (historyMeta.isLoadingMore || !historyMeta.hasMore) {
    return transcriptions;
  }

  setHistoryMeta({ isLoadingMore: true });
  const sequence = ++loadSequence;
  try {
    const result = await window.electronAPI.queryTranscriptionHistory({
      requestKey: "history-store",
      limit: pageSize,
      offset: historyMeta.nextCursor ? 0 : transcriptions.length,
      cursor: historyMeta.nextCursor || null,
    });
    if (sequence !== loadSequence || result?.cancelled) {
      return transcriptions;
    }

    const existingIds = new Set(transcriptions.map((item) => item.id));
    const nextItems = (result?.items || []).filter((item) => !existingIds.has(item.id));
    transcriptions = [...transcriptions, ...nextItems];
    currentLimit = transcriptions.length;
    historyMeta = {
      hasMore: result?.hasMore === true,
      totalCount: Math.max(
        transcriptions.length,
        Number(result?.totalCount) || historyMeta.totalCount
      ),
      nextCursor: result?.nextCursor || null,
      isLoadingMore: false,
    };
    emit();
    return transcriptions;
  } finally {
    if (sequence === loadSequence && historyMeta.isLoadingMore) {
      setHistoryMeta({ isLoadingMore: false });
    }
  }
}

export function addTranscription(item: TranscriptionItem) {
  if (!item) return;
  const alreadyLoaded = transcriptions.some((existing) => existing.id === item.id);
  const withoutDuplicate = transcriptions.filter((existing) => existing.id !== item.id);
  transcriptions = [item, ...withoutDuplicate].slice(0, currentLimit);
  historyMeta = {
    ...historyMeta,
    totalCount: historyMeta.totalCount + (alreadyLoaded ? 0 : 1),
    hasMore:
      historyMeta.hasMore ||
      historyMeta.totalCount + (alreadyLoaded ? 0 : 1) > transcriptions.length,
  };
  emit();
}

export function removeTranscription(id: number) {
  if (!id) return;
  const next = transcriptions.filter((item) => item.id !== id);
  if (next.length === transcriptions.length) return;
  transcriptions = next;
  historyMeta = {
    ...historyMeta,
    totalCount: Math.max(0, historyMeta.totalCount - 1),
    hasMore: historyMeta.hasMore && next.length < historyMeta.totalCount - 1,
  };
  emit();
}

export function updateTranscription(id: number, patch: Partial<TranscriptionItem>) {
  if (!id) return;
  let changed = false;
  const next = transcriptions.map((item) => {
    if (item.id === id) {
      changed = true;
      return { ...item, ...patch };
    }
    return item;
  });
  if (!changed) return;
  transcriptions = next;
  emit();
}

export function clearTranscriptions() {
  transcriptions = [];
  currentLimit = DEFAULT_LIMIT;
  loadSequence += 1;
  historyMeta = { hasMore: false, totalCount: 0, isLoadingMore: false, nextCursor: null };
  emit();
}

export function useTranscriptions() {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function useTranscriptionHistoryMeta() {
  return useSyncExternalStore(subscribe, getMetaSnapshot, getMetaSnapshot);
}
