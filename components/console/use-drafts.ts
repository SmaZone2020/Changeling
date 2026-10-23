"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import type { FinishReason } from "@/lib/types";

/**
 * Draft buffer keyed by turn id.
 *
 * Switching sessions unmounts the composer, so without this an operator who
 * alt-tabs to another agent mid-reply would lose everything they typed.
 */

export interface Draft {
  content: string;
  calls: Array<{ key: string; name: string; args: string }>;
  finish: FinishReason;
}

const EMPTY: Draft = { content: "", calls: [], finish: "tool_calls" };

export function useDrafts() {
  const store = useRef(new Map<string, Draft>());
  const [, force] = useState(0);

  const get = useCallback((turnId: string): Draft => {
    return store.current.get(turnId) ?? EMPTY;
  }, []);

  const set = useCallback((turnId: string, draft: Draft) => {
    store.current.set(turnId, draft);
  }, []);

  const drop = useCallback((turnId: string) => {
    store.current.delete(turnId);
    force((n) => n + 1);
  }, []);

  const pendingDrafts = useMemo(() => {
    let n = 0;
    for (const d of store.current.values()) {
      if (d.content.trim() || d.calls.length) n++;
    }
    return n;
  }, [store.current]);

  return { get, set, drop, pendingDrafts };
}

export type DraftApi = ReturnType<typeof useDrafts>;
