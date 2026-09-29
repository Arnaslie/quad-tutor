import { ButtonLink } from "@/components/button";
import { Card } from "@/components/card";
import { Icon } from "@/components/icons";

export const SET_LOCATION_HREF = "/tutor/availability";

export function LocationNudge() {
  return (
    <Card className="flex flex-col items-start gap-3">
      <div className="flex gap-3">
        <Icon name="pin" className="mt-0.5 size-[18px] shrink-0 text-muted" />
        <div className="flex flex-col gap-0.5">
          <p className="text-sm font-medium text-foreground">
            You have not set where you meet
          </p>
          <p className="text-sm text-muted">
            Students booking you are told the spot is not decided yet. Set it once and
            every booking uses it.
          </p>
        </div>
      </div>
      <ButtonLink href={SET_LOCATION_HREF} variant="secondary">
        Set your spot
      </ButtonLink>
    </Card>
  );
}
