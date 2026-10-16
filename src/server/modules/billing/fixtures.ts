export const PERSONA_PREFIX = "persona_";
export const PERSONA_SECTION = "persona";
export const PERSONA_INBOX = { local: "arnutislie12", domain: "gmail.com" };
export const PERSONA_MAIL_READER = "jmgucius@crimson.ua.edu";
export const FIXTURE_PREFIX = "fixture_";
export const FIXTURE_PAYMENT_PREFIX = "fixture_pi_";
export const FIXTURE_TRANSFER_PREFIX = "fixture_tr_";

export type FixtureTransferReference = `${typeof FIXTURE_TRANSFER_PREFIX}${string}`;

export const isPersona = (userId: string) => userId.startsWith(PERSONA_PREFIX);
export const isPersonaEmail = (address: string) => {
  const lower = address.toLowerCase();
  return lower.startsWith(`${PERSONA_INBOX.local}+`) && lower.endsWith(`@${PERSONA_INBOX.domain}`);
};
export const isFixture = (reference: string | null) => reference?.startsWith(FIXTURE_PREFIX) ?? false;

export function refuseFixture(reference: string): void {
  if (isFixture(reference)) throw new Error(`Fixture money never reaches Stripe: ${reference}`);
}
