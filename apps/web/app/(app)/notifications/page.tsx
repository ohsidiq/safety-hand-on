import type { Metadata } from "next";
import { NotificationsView } from "./notifications-view";

export const metadata: Metadata = { title: "Notifikasi" };

export default function NotificationsPage() {
  return (
    <>
      <h1>Notifikasi</h1>
      <NotificationsView />
    </>
  );
}
