"use client";

import { useEffect, useRef, useState } from "react";
import { API_URL, DEMO } from "./config";
import { demoData } from "./demo";
import { useLane, withLane } from "./lane";

/** Poll a Worker endpoint. Falls back to built-in demo data when no API URL is configured. */
export function usePoll<T>(rawPath: string, intervalMs = 10_000) {
  const { lane } = useLane();
  const path = withLane(rawPath, lane);
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    let alive = true;
    setData(null); // lane or path changed: don't show the previous lane's numbers
    const load = async () => {
      try {
        const next = DEMO ? (demoData(path) as T) : await (await fetch(`${API_URL}${path}`, { cache: "no-store" })).json();
        if (!alive) return;
        if (next && typeof next === "object" && "error" in (next as object)) throw new Error(String((next as { error: unknown }).error));
        setData(next as T);
        setError(null);
        setUpdatedAt(Date.now());
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      } finally {
        // pause polling while the tab is hidden
        if (alive) timer.current = setTimeout(load, document.hidden ? intervalMs * 3 : intervalMs);
      }
    };
    load();
    return () => {
      alive = false;
      clearTimeout(timer.current);
    };
  }, [path, intervalMs]);

  return { data, error, updatedAt };
}
