import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { magicLink } from "better-auth/plugins/magic-link";
import { eq } from "drizzle-orm";

import { db } from "./db";
import { sendEmail } from "./modules/notifications/email";
import * as schema from "./db/schema";
import { institution, studentProfile } from "./db/schema";

export const NAME_REQUIRED_MESSAGE =
  "Add your name — tutors see it when you ask them for help.";

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
    validateUserInfo: async ({ user, source }) => {
      if (source.action !== "create-user") return;

      const email = typeof user.email === "string" ? user.email : null;
      if (!email) return { error: "An email address is required." };

      const match = await institutionForEmail(email);
      if (!match) {
        return { error: "Sign up with your university email address." };
      }

      const name = typeof user.name === "string" ? user.name.trim() : "";
      if (!name) return { error: NAME_REQUIRED_MESSAGE };
    },
  },

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
        if (!(await institutionForEmail(email))) {
          throw new APIError("BAD_REQUEST", {
            message: "Sign up with your university email address.",
          });
        }

        await sendEmail({
          to: email,
          subject: "Your Quad Tutor sign-in link",

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
