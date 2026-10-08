export class EmailError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
  ) {
    super(message);
  }

  get terminal(): boolean {
    return (
      this.status !== undefined &&
      this.status >= 400 &&
      this.status < 500 &&
      this.status !== 409 &&
      this.status !== 429
    );
  }
}

export function failureStatus(error: unknown): string {
  if (error instanceof EmailError) {
    if (error.status === undefined) return error.message;
    return error.code ? `${error.status} ${error.code}` : String(error.status);
  }
  if (!(error instanceof Error)) return "unknown";
  const cause = (error.cause as { code?: unknown } | undefined)?.code;
  return typeof cause === "string" ? `${error.name} ${cause}` : error.name;
}

async function errorName(response: Response): Promise<string | undefined> {
  try {
    const body: unknown = await response.json();
    const name = (body as { name?: unknown } | null)?.name;
    return typeof name === "string" ? name : undefined;
  } catch {
    return undefined;
  }
}

export type Email = {
  to: string;
  subject: string;
  text: string;
  idempotencyKey?: string;
};

function sender(): string {
  return process.env.EMAIL_FROM ?? "Quad Tutor <onboarding@resend.dev>";
}

export async function sendEmail(message: Email): Promise<void> {
  const key = process.env.RESEND_API_KEY;

  if (!key) {
    if (process.env.NODE_ENV === "production") {
      throw new EmailError("RESEND_API_KEY is not set — refusing to drop mail silently.");
    }

    console.log(`\n[email] to: ${message.to}`);
    console.log(`[email] subject: ${message.subject}`);
    if (message.idempotencyKey) console.log(`[email] idempotency-key: ${message.idempotencyKey}`);
    console.log(`${message.text}\n`);
    return;
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      ...(message.idempotencyKey ? { "Idempotency-Key": message.idempotencyKey } : {}),
    },
    body: JSON.stringify({
      from: sender(),
      to: [message.to],
      subject: message.subject,
      text: message.text,
    }),
  });

  if (response.ok) return;
  const name = await errorName(response);
  if (response.status === 409 && name === "invalid_idempotent_request") {
    console.warn(`[email] ${message.idempotencyKey} already delivered`);
    return;
  }
  throw new EmailError(
    `Resend refused the message (${response.status} ${name ?? "unnamed"})`,
    response.status,
    name,
  );
}
