/**
 * Outbound email via Resend, over `fetch` — the request is one POST, so an SDK
 * would only add a version to keep current.
 *
 * With a key, send. Without one in development, log. Without one in
 * production, throw: dropping a magic link silently leaves someone staring at
 * "check your email" with nothing in any log.
 */

export class EmailError extends Error {}

export type Email = {
  to: string;
  subject: string;
  text: string;
};

/** Must be on a domain verified with Resend, or every send is rejected. */
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
    console.log(`${message.text}\n`);
    return;
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from: sender(),
      to: [message.to],
      subject: message.subject,
      text: message.text,
    }),
  });

  if (!response.ok) {
    // Their body names the bad field; losing it hides a typo in EMAIL_FROM.
    const detail = await response.text();
    throw new EmailError(`Resend refused the message (${response.status}): ${detail}`);
  }
}
