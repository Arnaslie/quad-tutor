import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { magicLink } from "better-auth/plugins/magic-link";
import { eq } from "drizzle-orm";

import { db } from "./db";
import * as schema from "./db/schema";
import { institution } from "./db/schema";

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

        // No email provider yet. Logging the link keeps local sign-in working
        // without pulling in a vendor before there is a product to send from.
        if (process.env.NODE_ENV === "production") {
          throw new Error("sendMagicLink has no email provider configured");
        }
        console.log(`\n[magic-link] ${email}\n[magic-link] ${url}\n`);
      },
    }),
  ],
});
