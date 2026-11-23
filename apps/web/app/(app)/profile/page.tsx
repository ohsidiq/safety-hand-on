import type { Metadata } from "next";
import { AccountView } from "./account-view";

export const metadata: Metadata = { title: "Profil" };

export default function ProfilePage() {
  return (
    <>
      <h1>Profil</h1>
      <AccountView />
    </>
  );
}
