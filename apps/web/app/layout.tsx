import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { ServiceWorkerRegister } from "./sw-register";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Safety On Hand", template: "%s · Safety On Hand" },
  description: "Kesiapan kerja dan kepatuhan keselamatan tenaga kerja",
  applicationName: "Safety On Hand",
  appleWebApp: { capable: true, title: "Safety On Hand", statusBarStyle: "default" },
  icons: { apple: "/icons/apple-touch-icon.png" },
};

export const viewport: Viewport = {
  themeColor: "#1f2937",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="id">
      <body>
        {children}
        <ServiceWorkerRegister />
      </body>
    </html>
  );
}
