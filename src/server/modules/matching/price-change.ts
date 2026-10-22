import { formatMinor } from "@/server/modules/billing/pricing";

type Change = { from: string; to: string; raised: boolean };

function change(askedMinor: number | null, nowMinor: number | null): Change | null {
  if (askedMinor === null || nowMinor === null || askedMinor === nowMinor) return null;
  return { from: formatMinor(askedMinor), to: formatMinor(nowMinor), raised: nowMinor > askedMinor };
}

export function priceChangeForStudent(params: {
  tutorName: string;
  askedMinor: number | null;
  quotedMinor: number | null;
}): string | null {
  const moved = change(params.askedMinor, params.quotedMinor);
  if (!moved) return null;
  return moved.raised
    ? `${params.tutorName} raised their price from ${moved.from} to ${moved.to} a session since you asked. You can still pick someone else.`
    : `${params.tutorName} lowered their price from ${moved.from} to ${moved.to} a session since you asked.`;
}

export function priceChangeForTutor(params: {
  askedMinor: number | null;
  currentMinor: number;
}): string | null {
  const moved = change(params.askedMinor, params.currentMinor);
  if (!moved) return null;
  return `They asked when your price was ${moved.from}. They will see your new price, ${moved.to}, before they pay.`;
}
