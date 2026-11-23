import type { Metadata } from "next";
import { WorkerDetailView } from "./worker-detail-view";

export const metadata: Metadata = { title: "Detail pekerja" };

export default async function WorkerDetailPage({ params }: PageProps<"/workers/[id]">) {
  const { id } = await params;
  return <WorkerDetailView id={id} />;
}
