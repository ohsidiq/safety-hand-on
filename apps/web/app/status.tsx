"use client";

import { useEffect, useState } from "react";
import { type ApiStatus, fetchApiStatus } from "@/lib/api";

const LABEL: Record<ApiStatus | "LOADING", string> = {
  LOADING: "Memeriksa Core API…",
  UP: "Core API berjalan",
  DOWN: "Core API tidak dapat dijangkau",
  UNKNOWN: "Alamat Core API belum diatur",
};

export function ApiStatusBadge() {
  const [status, setStatus] = useState<ApiStatus | "LOADING">("LOADING");
  useEffect(() => {
    fetchApiStatus().then(setStatus);
  }, []);
  return (
    <p className={`status status-${status.toLowerCase()}`} role="status" aria-live="polite">
      <span className="dot" aria-hidden="true" />
      {LABEL[status]}
    </p>
  );
}
