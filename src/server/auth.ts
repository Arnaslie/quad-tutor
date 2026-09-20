import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { magicLink } from "better-auth/plugins/magic-link";
import { eq } from "drizzle-orm";

import { db } from "./db";
import { sendEmail } from "./modules/notifications/email";
import * as schema from "./db/schema";
import { institution, studentProfile } from "./db/schema";

/**
 * Surfaced to the person on the sign-in screen, so it is exported rather than
 * inlined: `src/app/(auth)/sign-in/page.tsx` matches on it to decide that an
 * `?error=` it was handed is our own wording and safe to render. Two copies of
 * this string would drift and quietly downgrade the message to the generic one.
 */
export const NAME_REQUIRED_MESSAGE =
  "Add your name — tutors see it when you ask them for help.";

/** Signup is gated on institutional email. Campus membership is the product boundary. */
async function institutionForEmail(email: string) {
  const domain = email.split("@").at(1)?.toLowerCase();
  if (!domain) return null;

  const rows = await db
    .select({ id: institution.id })
    .from(institution)
    .where(eq(institution.emailDomain, domain))
    .limit(1);

  return rows.at(0) ?? null;
}

export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: "pg", schema }),

  user: {
    /**
     * .edu verification replaces background checks, so an address from outside a
     * known campus must never produce a user row. Rejecting here keeps that out
     * of the database entirely rather than cleaning up after the fact.
     */
    validateUserInfo: async ({ user, source }) => {
      if (source.action !== "create-user") return;

      const email = typeof user.email === "string" ? user.email : null;
      if (!email) return { error: "An email address is required." };

      const match = await institutionForEmail(email);
      if (!match) {
        return { error: "Sign up with your university email address." };
      }

      // The sign-in form marks this required, but `required` is a hint to a
      // cooperative browser — the endpoint is a reachable POST. A user row with
      // no name renders as a card from nobody in a tutor's inbox, so the
      // guarantee has to live at the boundary rather than in the markup.
      const name = typeof user.name === "string" ? user.name.trim() : "";
      if (!name) return { error: NAME_REQUIRED_MESSAGE };
    },
  },

  /**
   * Every user starts as a student. The profile is created with the user row
   * rather than lazily on first page load, so `currentActor` can inner-join it
   * and no read path has to carry a write side-effect.
   *
   * `validateUserInfo` has already refused any address outside a known campus,
   * so a missing institution here is a bug, not a user error.
   */
  databaseHooks: {
    user: {
      create: {
        after: async (created) => {
          const match = await institutionForEmail(created.email);
          if (!match) return;

          await db
            .insert(studentProfile)
            .values({ userId: created.id, institutionId: match.id })
            .onConflictDoNothing();
        },
      },
    },
  },

  plugins: [
    magicLink({
      async sendMagicLink({ email, url }) {
        // validateUserInfo runs at user creation, which is the link *click*.
        // Without this check a stranger's inbox gets mail before we ever decide
        // they are eligible. Refuse at send, not after.
        if (!(await institutionForEmail(email))) {
          throw new APIError("BAD_REQUEST", {
            message: "Sign up with your university email address.",
          });
        }

        // `sendEmail` decides how: Resend when a key is configured, the console
        // in development when one is not, and a throw in production rather than
        // dropping a link somebody is waiting on.
        await sendEmail({
          to: email,
          subject: "Your Quad Tutor sign-in link",
          // Plain text on purpose. A sign-in link is read in two seconds and
          // has one job, so there is nothing for markup to add, and text
          // renders identically in every client and filter.
          text: [
            "Sign in to Quad Tutor:",
            "",
            url,
            "",
            "The link works once and expires shortly.",
            "If you did not ask for it, ignore this — nobody can sign in without it.",
          ].join("\n"),
        });
      },
    }),
  ],
});
