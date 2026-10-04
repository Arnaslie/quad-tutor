export type AnswerOutcome = "attended" | "not_attended" | "awaiting_other" | "disputed";

export function outcomeOf(status: "scheduled" | "completed" | "cancelled" | "disputed"): AnswerOutcome {
  if (status === "disputed") return "disputed";
  if (status === "scheduled") return "awaiting_other";
  return status === "completed" ? "attended" : "not_attended";
}

export function answerCopy(params: {
  outcome: AnswerOutcome;
  answer: "confirmed" | "denied";
  viewer: "student" | "tutor";
  otherPartyName: string;
}): string {
  const other = params.otherPartyName;
  switch (params.outcome) {
    case "attended":
      return params.viewer === "tutor"
        ? "Confirmed by both of you. This session is delivered and earned."
        : "Confirmed by both of you. This session is settled.";
    case "not_attended":
      return params.viewer === "tutor"
        ? `You both said it did not happen. The session goes back to ${other}'s package.`
        : "You both said it did not happen. The session goes back into your package.";
    case "disputed":
      return `You and ${other} gave different answers. Nothing moves until someone reviews it.`;
    case "awaiting_other":
      return `${params.answer === "confirmed" ? "Confirmed" : "Reported"}. Waiting on ${other} to answer — we will email you when it settles.`;
  }
}
