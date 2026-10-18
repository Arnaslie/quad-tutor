# Tutor background checks

Status: **proposal, waiting for the owner's approval.** Nothing is built. Written
2026-10-18 against `origin/main` at `2e9d50a`. Every code reference below was checked at
that commit. This is not legal advice. It is a research summary to take to a lawyer.

## The ask

The owner asked to "implement a background check for tutors in the same phase that they
upload transcript to provide credibility for course mentoring."

`docs/decisions.md` rejects this today (Rejected, line 888): "They buy nothing once
minors are out of scope. `.edu` verification plus per-course grade proof replaces them."
Building it means reversing that entry first, so this proposal asks for the reversal and
sets out what the build would be.

## Reverse the rejection for safety, not credibility

The rejection is right about credibility. A verified grade under the same professor is
the credibility signal, and it is the whole wedge. A clean criminal record says nothing
about whether someone can teach MATH 125. Arguing for the check on credibility would
argue against the product's own reason to exist.

Safety is the reason that holds. Sessions are one-on-one and in person, at a spot the
tutor picks (`decisions.md:256`, "The tutor owns the meeting spot"). Two adults who met
through our deck sit alone together. A check that screens for sex and violent offenses
is a fair thing for a student to expect before that meeting. The rejection was written
when minors left scope, and it did not weigh this case. The reversal entry should say
that `.edu` and grade proof still prove who the tutor is and that they can teach, and
that the check answers a different question.

## Recommendation

**Vendor: Checkr Basic, through its hosted invite.** Basic is $29.99 and covers an SSN
trace, the national criminal database, the sex offender registry and a global watchlist.
A county search costs $25 more when the database search points to a county. We create a
candidate with only an email address and send an invite. On Checkr's page the tutor types
their own details and signs the disclosure and authorization. We store a status, vendor
ids and timestamps. We never store an SSN, a date of birth, an address history or any part
of the report. Checkr's free staging environment returns fixed mock people, which fits
the real and fake drivers `billing/stripe.ts` already uses. Stripe cannot stand in. Connect
KYC runs no criminal search, and Stripe Identity's terms forbid FCRA-type decisions. Certn is cheaper ($13.99
plus $9.99 per county) but Canada-first with a 72-hour average, so it stays the fallback
behind the same gateway.

**The platform pays.** About $35 per tutor on average. At a take of $1.75 to $3.50 per
session, that pays back in 10 to 20 sessions. A $30 fee before a student tutor earns
anything would cost supply on a new campus, and charging the person checked is a lawyer
question.

**Consent at the first proof upload. Invite only after that first grade proof is
approved.** The proof form gets a required "I agree to a background check" box the first
time a tutor uploads proof. Ticking it records consent. The Checkr invite goes out only
when an operator approves that first grade proof. A tutor whose grade proof is rejected
costs nothing.

This bends "same step." The tutor agrees on the proof page, but signs and types their SSN
on Checkr's page later, usually from an email a day or so after upload. That is a second
visit, and some tutors will drop off there. The alternative is to send the invite at
upload and redirect straight to Checkr. That is truly one step, but it pays about $35 for
every applicant whose grade proof is then rejected.

**Required to list.** A tutor shows to students only when a grade proof for the course is
approved and the check is clear. The check runs once per tutor, not per course. A second
course's proof does not start another one.

**No per-tutor badge.** Every listed tutor has passed, so a badge on each card says
nothing, and a missing one would read as "didn't pass" (`decisions.md:906-909` makes the
same point about badges). Students see one platform-wide sentence instead, for example
"Every tutor passes a criminal background check before they can list," linked to a short
page on what the check covers and what it misses.

**A filter, never a score.** The gate is a `WHERE` condition in `candidates.ts`. It never
reaches `score.ts`. The result is never a reliability fact and never feeds matching or
ranking. This copies "Blocks and reports are not reliability" (`decisions.md:324`).

**Why this does not reopen the KYC rejection.** Hiding unverified tutors was rejected for
KYC because KYC starts at the first accept, so hiding them would deadlock
(`decisions.md:756-758`). This check starts at proof upload, before the tutor is ever
listed. Gating on it cannot deadlock.

## The FCRA flow

Plan as if the FCRA's employment rules apply. The FTC says they cover independent
contractors, and some courts disagree. A willful violation costs $100 to $1,000 per
person plus damages and fees, and Postmates paid $2.5M over a buried disclosure. With a
vendor that hosts the forms and sends the notices, full compliance costs little extra.

1. **Certify.** The owner certifies the platform's permissible purpose to Checkr once, at
   onboarding.
2. **Standalone disclosure.** A document that is only the disclosure. No waiver, no terms,
   none of our text. Checkr hosts it.
3. **Written authorization.** The tutor signs on Checkr's page. If re-checks are planned,
   this is where the wording must say so.
4. **Pre-adverse action notice.** Before any action based even partly on the report, the
   tutor gets a copy of the report and the CFPB "Summary of Your Rights Under the FCRA"
   (current version March 2023).
5. **Wait at least 5 business days**, counted from receipt. We would set more.
6. **Final adverse action notice.** The vendor's contact details, a statement that the
   vendor did not decide, and the tutor's right to a free copy and to dispute.
7. **Disputes.** The vendor reinvestigates free within 30 days (45 if the tutor sends new
   information). We hold the decision until it resolves.

Checkr's adverse-action tool sends the notices in steps 4 and 6 and tracks disputes.
Checkr staging does not support post-adverse action, so that part is tested against our
fake driver only.

Adverse action here means refusing to list, removing, pausing or limiting a tutor when the
report played any part. The operator who reviews a report reads it in Checkr's dashboard
and nowhere else. The status itself is sensitive. It stays server-side, and only the tutor
sees their own. It never goes in Stripe metadata, analytics or anyone else's email.

## A tutor with paid packages gets a bad result

The gate means this happens only on a re-check, or to a tutor already listed when the gate
ships (production is test data until launch, `decisions.md:826-841`).

- **`needs_review`.** The tutor is delisted and cannot accept or be paid for new requests.
  Packages already paid keep running. The legal research says a pause may itself count as
  adverse action, which would need the pre-adverse notice first. The default is the
  owner's to confirm after the lawyer answers. In code it is one line in `listable()`.
- **`not_cleared`, after the final notice.** Pending requests are withdrawn and new
  bookings refused. An operator ends each live package through `closeWithRefund` with no
  `endedBy` (`engagements/termEnd.ts:88-91`), the path the term-end sweep already uses.
  Delivered sessions stay paid and the tutor keeps every cent earned. Undelivered sessions
  refund to the student. No reliability fact is written for either side.
- `closeWithRefund` still refuses while a session is past its start and unconfirmed, or
  disputed (`termEnd.ts:128-131`). The operator retries once that settles.
- Earned pay keeps flowing. The transfer sweep keys on KYC, not on the check
  (`billing/transfers.ts:150-160`), and should stay that way.
- The student is never told why. The email says something like "Your tutor is no longer
  available. Your unused sessions have been refunded. Here are other tutors for MATH 125."

This needs a change to "Only the student can end their package" (`decisions.md:51`), to
allow an operator to end the packages of a tutor whose check was not cleared.

## Where it fits in the code

Paths drop the `src/server/modules/`, `src/app/` and `src/app/(tutor)/tutor/` prefixes.

- **Proof flow.** `ProofForm` posts to `submitProofAction` (`courses/actions.ts:60-88`),
  which calls `submitProof` (`tutoring/verification.ts:61-148`). `submitProof` stays as it
  is. After it returns, the action inserts a `consented` check row if the tutor has none.
- **Invite.** `decide()` (`verification.ts:172-213`) approves a claim. After it commits,
  `sendInvite` calls the gateway with idempotency key `bgcheck-invite:<check id>`. The cron
  sweep sends any invite that failed. This follows the CLAUDE.md money rule. Write the
  row, commit, call the vendor, then record the vendor ids.
- **Schema.** One new table, `background_check`, with `institution_id`, the tutor profile,
  a status (`consented`, `invited`, `in_progress`, `clear`, `needs_review`, `not_cleared`,
  `expired`), vendor ids, step timestamps, `decided_by_user_id`, `notified_at` and the
  adjudication policy version. A partial unique index allows one live check per tutor. The
  migration is additive and touches no existing table. The check lives on the tutor, not on
  `tutor_course` (`schema.ts:317-359`), because it is a fact about the person.
- **Gateway.** `src/server/modules/screening/` copies `billing/stripe.ts`. A real driver
  refuses live keys (`stripe.ts:317-328`). A file-backed fake is refused in production
  (`:540-544`), and a dev hosted page copies `api/dev/connect/[id]/route.ts:18-42`. A pure
  `status.ts` maps vendor state to our enum, as `billing/kyc.ts:11-19` does.
- **Webhook.** A new route verifies the HMAC signature, then re-reads the invite or report
  from Checkr and writes status from that, as `syncConnectAccount` does
  (`billing/connect.ts:99-108`). Repeated and out-of-order events converge, so no event
  table is needed. A write is skipped once an operator has decided.
- **Sweep.** `syncOpenChecks` joins the per-campus loop in `api/cron/route.ts:65-111`. It
  sends unsent invites, re-reads stale open checks and expires lapsed invites (Checkr's
  expire after 7 days).
- **Email.** `notifyCheckOutcomes` sits next to `notifyVerificationDecisions`
  (`notifications/dispatch.ts:612-685`), guarded by `notified_at`.
- **Gate.** A shared `listable()` replaces `tutorCourse.status = 'active'` in the deck
  (`matching/candidates.ts:93`), new requests (`matching/requests.ts:147`), book again and
  top-up (`engagements/reads.ts:388`) and the section-covered email (`dispatch.ts:542`).
  `acceptRequest` (`requests.ts:226-238`) and `purchasePackage`
  (`engagements/purchase.ts:301-303`) check nothing today and each get a guard. `DeckCard`
  (`candidates.ts:20-29`) and `score.ts` do not change.
- **Copy.** `statusCopy` says `active` means "Live. Students in this course can ask you."
  (`courses/page.tsx:284-285`). That becomes wrong, so an approved course with no clear
  check reads "Grade checked. You go live once your background check clears."

## Delivery: 8 stacked PRs

| # | PR | Depends on | Merges |
|---|---|---|---|
| 1 | This proposal. After approval, the `decisions.md` edits land here before any build. | none | owner |
| 2 | Schema: enum, `background_check` table, migration `0033`. Nothing reads it. | 1 | owner |
| 3 | Gateway: real and fake drivers, `status.ts` with tests, dev hosted page, `.env.example`, merge-gate patterns for the gateway and `SCREENING_` keys. | 1 | owner |
| 4 | Consent and invite: proof-form box, `consented` row, invite after first approval, "Finish your background check" link, copy. No gate yet. | 2, 3 | pstack |
| 5 | Webhook, `syncOpenChecks`, outcome emails. | 4 | pstack |
| 6 | Seed and personas write `clear` fixture checks. e2e drives the fake hosted page. | 2 | pstack |
| 7 | Gate: `listable()` in four paths, guards in `acceptRequest` and `purchasePackage`, `statusCopy`, the public sentence. After 6, so seed decks stay full. | 5, 6 | pstack |
| 8 | Ops: review on `/ops/verifications`, `not_cleared` effects, `closeWithRefund` per package. Runs `db:check-money`. | 7 | pstack unless merge-gate flags it |

## Cost

| Option | Clean record | Record found | Sessions to pay back |
|---|---|---|---|
| Checkr Basic, county on a hit (recommended) | $29.99 + court fees | $54.99 + court fees | 10 to 20 at ~$35 |
| Checkr Essential, every county for 7 years | $59.99 + court fees | $59.99 + court fees | 17 to 34 |
| Certn Core, county on a hit (fallback) | $13.99 or $17.99 | $23.98 | 4 to 14 |
| Certn Complete, every county | $49.99 | $49.99 | 15 to 29 |

Court fees are passed through at cost. Alabama county fees are unconfirmed, so plan for $0
to $10 per county. Fifty tutors in year one is about $1,750 on Checkr Basic and about
$3,000 on Essential. Sending the invite at upload instead adds about $35 for each rejected
applicant.

## Decisions only the owner can make

1. **Reverse the rejection** in `decisions.md`, with safety as the reason.
2. **The adjudication policy.** Which findings disqualify (likely sex offenses, violence
   against a person, maybe stalking or harassment). The lookback for each category (Wyzant
   uses 7 years for felonies and no limit for the registry). What is never considered:
   arrests without conviction, expunged or sealed records, juvenile records, minor traffic.
   What a pending charge means. Who decides, and how fast. How a tutor sends context.
3. **Required to list or optional.** The recommendation is required, with no badge.
4. **Who pays.** The recommendation is the platform.
5. **Invite timing.** After the first approval (recommended, bends "same step") or at
   upload (one step, pays for rejected applicants).
6. **Re-check cadence.** Once, each fall, or continuous. This sets the authorization
   wording, so it is needed before the first live check.
7. **The platform ends a package.** Amend "Only the student can end their package."
8. **What happens during review.** Delist on `needs_review`, or keep listed until the
   pre-adverse notice, and whether a severe result may pause a tutor early.
9. **The vendor contract.** Checkr, hosted forms, the current Summary of Rights, 5-year
   record retention, SSN never sent to us. The API account needs a registered business,
   an EIN and articles of incorporation, and a call with a Checkr account executive.
10. **The public sentence** students see, and the page it links to.

## Questions for a lawyer

1. Do tutor checks count as "employment purposes" under the FCRA? What should the forms say
   for contractors?
2. Is delisting or pausing during review adverse action that needs the pre-adverse notice
   first? Is any interim step safe for a severe result?
3. How long should the waiting period be beyond 5 business days?
4. Is the adjudication policy sound under 42 U.S.C. § 1981 and Alabama law, now that the
   EEOC's 2012 guidance is being rescinded?
5. Does any Tuscaloosa ordinance or University of Alabama policy touch screening of UA
   students by a platform? No ordinance turned up, which is not proof.
6. May the platform charge a tutor for a check that is required to list?
7. Does a required check add misclassification risk for independent contractors?
8. Is "Every tutor passes a criminal background check before they can list" safe under the
   FTC Act and Alabama's Deceptive Trade Practices Act, given database searches miss records?
9. What must the vendor contract say on retention, SSN handling and liability for its
   adverse-action automation?
10. Do the terms of service allow ending a student's package early on a tutor's removal?
11. Do we owe a removed tutor any reason beyond the FCRA notices?
12. Which state and city fair-chance laws reach contractors on future campuses? The policy
    carries `institution_id` so each campus can get its own.

## Vendor facts not yet confirmed

- Whether Checkr Basic orders the $25 county search on its own after a database hit.
- Alabama county court fees.
- Whether Checkr's API has a minimum volume or monthly fee.
- Whether Checkr treats student tutors as an employment-type permissible purpose.
- That the hosted flow never sends the SSN to us. A third-party page says so. Checkr's
  docs do not say it in those words, so put it in the contract.
- That Checkr's adverse-action tool attaches the March 2023 Summary of Rights.
- The webhook header (`X-Checkr-Signature`, HMAC-SHA256 per Checkr's docs) has to be
  checked against staging before the verifier ships.
- Certn's current price ($13.99 or $17.99) and current webhook header.

## Sources

Vendors
- Checkr pricing: https://checkr.com/pricing
- Checkr invitations and workflow: https://docs.checkr.com/#tag/Invitations
- Checkr webhooks: https://docs.checkr.com/#section/Webhooks
- Checkr staging: https://docs.checkr.com/#section/Getting-Started/Request-a-Staging-Account
- Checkr partner docs: https://docs.checkr.com/partners/
- Checkr continuous monitoring: https://checkr.com/our-technology/real-time-feed
- Certn pricing: https://certn.co/pricing-us
- Certn criminal checks: https://certn.co/us/criminal-record-checks/
- Stripe Identity use cases: https://docs.stripe.com/identity/use-cases
- Wyzant background check policy: https://support.wyzant.com/?p=389

Law and guidance
- 15 U.S.C. § 1681b: https://www.law.cornell.edu/uscode/text/15/1681b
- 15 U.S.C. § 1681c: https://www.law.cornell.edu/uscode/text/15/1681c
- 15 U.S.C. § 1681n: https://www.law.cornell.edu/uscode/text/15/1681n
- 15 U.S.C. § 1681i: https://www.govinfo.gov/content/pkg/USCODE-2022-title15/html/USCODE-2022-title15-chap41-subchapIII-sec1681i.htm
- FTC, Using Consumer Reports: https://www.ftc.gov/business-guidance/resources/using-consumer-reports-what-employers-need-know
- SHRM on contractors and the FCRA: https://www.shrm.org/in/topics-tools/news/talent-acquisition/fcra-apply-to-background-checks-independent-contractors
- Postmates settlement: https://certiphi.com/blogs/industry-news/2017/7/popular-courier-service-to-pay-$2.5m-to-settle-background-check-class-action
- Standalone disclosure (K&L Gates): https://www.klgates.com/Ninth-Circuit-Strictly-Construes-the-Fair-Credit-Reporting-Acts-Standalone-Disclosure-Requirement-for-Employers-02-26-2019
- Adverse action timing: https://www.truescreen.com/resource-center/compliance-services/timing-between-sending-pre-adverse-and-final-adverse-action-notices
- Updated Summary of Rights: https://www.hireright.com/blog/employers-must-implement-updated-fcra-summary-of-consumer-rights
- EEOC rescission: https://www.hrdive.com/news/eeoc-moves-to-rescind-conviction-and-arrest-record-guidance-from-2012/832553/
- Brown v. J. Kaz: https://case-law.vlex.com/vid/brown-v-j-kaz-885833456
- REDEEMER Act: https://ogletree.com/insights/alabamas-new-law-permits-the-expungement-of-criminal-records
- Alabama Data Breach Notification Act: https://law.justia.com/codes/alabama/title-8/chapter-38/
