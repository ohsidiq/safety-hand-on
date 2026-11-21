import type { MetadataRoute } from "next";

// PWA pada MVP (OD-GAP-02, B-26). Tema netral sampai tema perusahaan ditetapkan.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Safety On Hand",
    short_name: "Safety On Hand",
    description: "Kesiapan kerja dan kepatuhan keselamatan tenaga kerja",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#f9fafb",
    theme_color: "#1f2937",
    lang: "id",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
