"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

export function RefreshWhilePending({ every = 3000, times = 10 }: { every?: number; times?: number }) {
  const router = useRouter();

  useEffect(() => {
    let left = times;
    const timer = setInterval(() => {
      left -= 1;
      if (left <= 0) clearInterval(timer);
      router.refresh();
    }, every);
    return () => clearInterval(timer);
  }, [router, every, times]);

  return null;
}
