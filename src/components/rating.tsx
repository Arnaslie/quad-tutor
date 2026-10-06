import type { PublicRating } from "@/server/modules/ratings/rules";

import { Icon } from "./icons";

export function RatingLine({
  rating,
  empty,
  label,
  secondary = false,
}: {
  rating: PublicRating | null;
  empty: string;
  label?: string;
  secondary?: boolean;
}) {
  return (
    <span className={`flex items-center gap-2 ${secondary ? "text-muted" : "text-foreground"}`}>
      <Icon
        name="star"
        className={`size-4 shrink-0 ${rating && !secondary ? "fill-current text-accent" : "text-muted"}`}
      />
      <span>
        {rating
          ? `${label ? `${label} ` : ""}${rating.average} · ${rating.count} ${rating.count === 1 ? "rating" : "ratings"}`
          : empty}
      </span>
    </span>
  );
}
