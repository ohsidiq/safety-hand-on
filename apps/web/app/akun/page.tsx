import { redirect } from "next/navigation";

/** Rute lama (M1.4 awal). Rute baku UIUX-002 §4.5: /profile. */
export default function OldAccount() {
  redirect("/profile");
}
