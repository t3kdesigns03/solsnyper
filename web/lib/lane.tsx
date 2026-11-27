"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

// Which paper wallet ("lane") the dashboard is showing. Every usePoll request
// gets ?lane=<lane> appended, so the panels don't need to know about lanes.

export type Lane = "sniper" | "stable";
export const LANES: { id: Lane; label: string; blurb: string }[] = [
  { id: "sniper", label: "Sniper", blurb: "brand-new pools" },
  { id: "stable", label: "Stable", blurb: "established, liquid pools" },
];

const LaneContext = createContext<{ lane: Lane; setLane: (l: Lane) => void }>({ lane: "sniper", setLane: () => {} });

export function LaneProvider({ children }: { children: ReactNode }) {
  const [lane, setLaneState] = useState<Lane>("sniper");
  useEffect(() => {
    const fromUrl = new URLSearchParams(window.location.search).get("lane");
    if (fromUrl === "sniper" || fromUrl === "stable") setLaneState(fromUrl);
  }, []);
  const setLane = (l: Lane) => {
    setLaneState(l);
    const u = new URL(window.location.href);
    u.searchParams.set("lane", l);
    window.history.replaceState(null, "", u);
  };
  return <LaneContext.Provider value={{ lane, setLane }}>{children}</LaneContext.Provider>;
}

export const useLane = () => useContext(LaneContext);

export const withLane = (path: string, lane: Lane) => `${path}${path.includes("?") ? "&" : "?"}lane=${lane}`;
