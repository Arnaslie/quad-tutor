"use client";

import { startTransition, useActionState, useId, useState, type FormEvent } from "react";

import { Button, ButtonLink } from "@/components/button";
import { Field, Input } from "@/components/field";
import {
  MAX_SCREENSHOTS,
  PDF_TYPE,
  proofProblem,
  type ProofKind,
} from "@/server/modules/tutoring/proof-rules";

import { submitProofAction, type ClaimState } from "./actions";

const INITIAL: ClaimState = { status: "idle" };
const MAX_EDGE = 2000;

async function compress(file: File): Promise<File> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);

  const context = canvas.getContext("2d");
  if (!context) throw new Error("no canvas");
  context.fillStyle = "#fff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/jpeg", 0.85),
  );
  if (!blob) throw new Error("no blob");
  return new File([blob], file.name.replace(/\.[^.]+$/, "") + ".jpg", { type: "image/jpeg" });
}

const CHOICES: { kind: ProofKind; title: string; body: (code: string) => string }[] = [
  {
    kind: "official_transcript",
    title: "Official transcript PDF (preferred)",
    body: () =>
      "Order it in myBama through Parchment and upload the PDF they send you. It is digitally signed, so it is the quickest to check. Parchment charges for it.",
  },
  {
    kind: "screenshot",
    title: "Screenshots of your unofficial transcript",
    body: (code) =>
      `From myBama, up to ${MAX_SCREENSHOTS} images. Your name at the top and the ${code} row with its grade both have to be visible.`,
  },
];

export function ProofForm({
  tutorCourseId,
  courseCode,
}: {
  tutorCourseId: string;
  courseCode: string;
}) {
  const [state, submit, pending] = useActionState(submitProofAction, INITIAL);
  const [kind, setKind] = useState<ProofKind>("official_transcript");
  const [problem, setProblem] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);
  const fileId = useId();

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setProblem(null);

    const input = event.currentTarget.elements.namedItem("files") as HTMLInputElement;
    const picked = Array.from(input.files ?? []);

    let files: File[];
    try {
      setPreparing(true);
      files =
        kind === "screenshot"
          ? await Promise.all(picked.map(compress))
          : picked.map((file) =>
              file.type || !file.name.toLowerCase().endsWith(".pdf")
                ? file
                : new File([file], file.name, { type: PDF_TYPE }),
            );
    } catch {
      setProblem("One of those images would not open. Save the screenshot as PNG or JPEG and try again.");
      return;
    } finally {
      setPreparing(false);
    }

    const found = proofProblem(kind, files);
    if (found) {
      setProblem(found);
      return;
    }

    const form = new FormData();
    form.set("tutorCourseId", tutorCourseId);
    form.set("kind", kind);
    for (const file of files) form.append("files", file);
    startTransition(() => submit(form));
  }

  const error = problem ?? (state.status === "error" ? state.message : undefined);
  const busy = pending || preparing;

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-5">
      <fieldset className="flex flex-col gap-3">
        <legend className="mb-1.5 text-sm font-medium text-foreground">What are you sending?</legend>
        {CHOICES.map((choice) => (
          <label
            key={choice.kind}
            className={`flex cursor-pointer gap-3 rounded-xl border p-3.5 ${
              kind === choice.kind ? "border-accent bg-accent-soft" : "border-border"
            }`}
          >
            <input
              type="radio"
              name="kind"
              value={choice.kind}
              checked={kind === choice.kind}
              onChange={() => setKind(choice.kind)}
              className="mt-1 accent-accent"
            />
            <span className="flex flex-col gap-1">
              <span className="text-sm font-medium text-foreground">{choice.title}</span>
              <span className="text-sm text-muted">{choice.body(courseCode)}</span>
            </span>
          </label>
        ))}
      </fieldset>

      <Field
        id={fileId}
        label={kind === "official_transcript" ? "Transcript PDF" : "Screenshots"}
        hint="Only the person checking it sees the file, and we delete it once it is checked."
        error={error}
      >
        <Input
          key={kind}
          id={fileId}
          name="files"
          type="file"
          required
          multiple={kind === "screenshot"}
          accept={kind === "official_transcript" ? "application/pdf,.pdf" : "image/*"}
          className="py-2.5 file:mr-3 file:rounded-lg file:border-0 file:bg-surface-sunken file:px-3 file:py-1.5 file:text-sm file:text-foreground"
        />
      </Field>

      <div className="flex flex-col gap-3 sm:flex-row-reverse sm:justify-end">
        <Button type="submit" size="lg" disabled={busy}>
          {busy ? "Sending…" : "Send for checking"}
        </Button>
        <ButtonLink href="/tutor/courses" variant="secondary" size="lg">
          Later
        </ButtonLink>
      </div>
    </form>
  );
}
