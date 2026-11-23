import type { ReactNode } from "react";
import { SessionProvider } from "@/lib/session";
import { AppShell } from "./app-shell";

/** Halaman yang memerlukan login: sesi dan identitas disiapkan sekali untuk semua halaman di grup ini. */
export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <SessionProvider>
      <AppShell>{children}</AppShell>
    </SessionProvider>
  );
}
