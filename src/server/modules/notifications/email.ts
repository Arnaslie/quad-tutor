export class EmailError extends Error {
  constructor(
    message: string,
    readonly status?: number,
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

  if (!response.ok) {
    const detail = await response.text();
    throw new EmailError(
      `Resend refused the message (${response.status}): ${detail}`,
      response.status,
    );
  }
}
