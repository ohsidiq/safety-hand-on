import type { HandlerRegistry } from "./outbox.js";

/**
 * Daftar handler event. M0 hanya berisi event uji asap (smoke test) untuk membuktikan jalur.
 * Handler readiness, notifikasi, dan audit ditambahkan di M1 (PLT02, PLT03) dan M4 (Readiness Engine).
 */
export const handlers: HandlerRegistry = {
  SYSTEM_PING: async () => {
    // Tidak ada efek samping. Dipakai untuk memastikan worker hidup dan outbox mengalir.
  },
};
