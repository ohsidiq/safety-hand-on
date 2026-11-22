import type { Metadata } from "next";
import { AccountView } from "./account-view";

export const metadata: Metadata = { title: "Akun saya" };

export default function AccountPage() {
  return (
    <main className="shell">
      <p className="eyebrow">Safety On Hand</p>
      <h1>Akun saya</h1>
      <AccountView />
    </main>
  );
}
