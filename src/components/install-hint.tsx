"use client";

import { useId, useState, useSyncExternalStore } from "react";

import { Button } from "./button";
import { Card } from "./card";
import { Icon } from "./icons";

const DISMISSED_KEY = "quad-tutor:install-hint-dismissed";

function shouldOffer() {
  const ios =
    /iPhone|iPad|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const installed =
    ("standalone" in navigator && navigator.standalone === true) ||
    window.matchMedia("(display-mode: standalone)").matches;
  if (!ios || installed) return false;

  try {
    return window.localStorage.getItem(DISMISSED_KEY) === null;
  } catch {
    return true;
  }
}

const subscribe = () => () => {};

export function InstallHint() {
  const offered = useSyncExternalStore(subscribe, shouldOffer, () => false);
  const [dismissed, setDismissed] = useState(false);
  const titleId = useId();

  if (!offered || dismissed) return null;

  return (
    <Card className="mb-6 flex items-start gap-3">
      <Icon name="share" className="mt-0.5 size-5 shrink-0 text-accent" />
      <p className="flex-1 text-sm">
        <span id={titleId} className="font-medium">Add Quad Tutor to your home screen.</span>{" "}
        <span className="text-muted">
          Tap Share, then Add to Home Screen. It opens like an app.
        </span>
      </p>
      <Button
        variant="ghost"
        className="-my-2 -mr-2 shrink-0"
        aria-describedby={titleId}
        onClick={() => {
          try {
            window.localStorage.setItem(DISMISSED_KEY, "1");
          } catch {}
          setDismissed(true);
        }}
      >
        Not now
      </Button>
    </Card>
  );
}
