import type { Metadata } from "next";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Masuk" };

export default function LoginPage() {
  return (
    <main className="shell">
      <p className="eyebrow">Safety On Hand</p>
      <h1>Masuk</h1>
      <p className="muted">Gunakan akun yang sudah didaftarkan administrator perusahaan Anda.</p>
      <LoginForm />
    </main>
  );
}
