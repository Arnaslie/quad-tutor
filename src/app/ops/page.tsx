import { redirect } from "next/navigation";

import { requireOperator } from "@/server/modules/identity/actor";

export default async function OpsHome() {
  await requireOperator();
  redirect("/ops/verifications");
}
