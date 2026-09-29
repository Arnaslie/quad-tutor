import { z } from "zod";

import { currentOperator } from "@/server/modules/identity/actor";
import { proofFileFor, readProof } from "@/server/modules/tutoring/verification";

const notFound = () => new Response("Not found", { status: 404 });

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ fileId: string }> },
) {
  const operator = await currentOperator();
  if (!operator) return notFound();

  const fileId = z.uuid().safeParse((await params).fileId);
  if (!fileId.success) return notFound();

  const file = await proofFileFor(operator, fileId.data);
  if (!file) return notFound();

  const stored = await readProof(file.pathname);
  if (!stored) return notFound();

  return new Response(stored.body, {
    headers: {
      "Content-Type": file.contentType,
      "Content-Disposition": "inline",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });
}
