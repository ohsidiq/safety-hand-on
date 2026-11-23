import { redirect } from "next/navigation";

/** Rute lama (M1.4 awal). Rute baku UIUX-002 §4.6: /login. */
export default function OldLogin() {
  redirect("/login");
}
