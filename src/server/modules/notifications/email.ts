/**
 * Outbound email. One function, one provider, no abstraction over it.
 *
 * Resend, called over plain `fetch` rather than through their SDK. The request
 * is a single POST with four fields, so a dependency would buy nothing but a
 * version to keep current. Swapping provider later means editing this file,
 * which is the same work an interface would have cost, minus the interface.
 *
 * Three behaviours, and the difference matters:
 *
 *   - Key configured: send it.
 *   - No key, development: log to the console. Local sign-in has always worked
 *     this way and still does, so nobody needs a Resend account to run this.
 *   - No key, production: throw. Silently dropping a magic link is worse than
 *     failing, because the person is left staring at "check your email" forever
 *     with nothing in any log to explain it.
 *
 * Delivery to `.edu` addresses is the whole job here, and university filters
 * are strict. That is a DNS problem, not a code one: SPF, DKIM and DMARC on the
 * sending domain. Without them a magic link lands in spam and sign-in appears
 * broken for reasons no amount of reading this file will reveal.
 */

export class EmailError extends Error {}

export type Email = {
  to: string;
  subject: string;
  /** Plain text is the body. Mail that renders as text survives every client. */
  text: string;
};

/** Resend rejects a `from` that is not on a verified domain. */
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
    // Their body says which field was wrong, and losing it turns a typo in
    // `EMAIL_FROM` into an unexplained failure.
    const detail = await response.text();
    throw new EmailError(`Resend refused the message (${response.status}): ${detail}`);
  }
}
