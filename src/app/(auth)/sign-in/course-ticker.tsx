"use client";

import Lenis from "lenis";
import { useEffect, useRef } from "react";

export type TickerPill = { code: string; title: string; detail: string };

const ROWS = [
  { speed: 21, offset: 0, accent: false },
  { speed: -27, offset: 1 / 3, accent: true },
  { speed: 18, offset: 2 / 3, accent: false },
];

const MIN_PILLS_PER_PERIOD = 12;

export function CourseTicker({ pills }: { pills: TickerPill[] }) {
  const period = Array.from({ length: Math.ceil(MIN_PILLS_PER_PERIOD / pills.length) }, () => pills).flat();

  return (
    <div
      aria-hidden
      className="mx-[calc(50%-50vw)] flex flex-col gap-2.5 [mask-image:linear-gradient(90deg,transparent,#000_12%,#000_88%,transparent)]"
    >
      {ROWS.map((row, index) => {
        const start = Math.floor(period.length * row.offset);
        return (
          <TickerRow
            key={index}
            pills={[...period.slice(start), ...period.slice(0, start)]}
            speed={row.speed}
            accent={row.accent}
          />
        );
      })}
    </div>
  );
}

function TickerRow({ pills, speed, accent }: { pills: TickerPill[]; speed: number; accent: boolean }) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const wrapper = wrapperRef.current;
    const content = contentRef.current;
    if (!wrapper || !content) return;

    const lenis = new Lenis({
      wrapper,
      content,
      orientation: "horizontal",
      syncTouch: true,
    });
    const drift = matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : speed;

    // scrollLeft rounds to whole pixels, so sub-pixel drift is tracked here instead.
    let pos = 0;
    let period = 0;
    const jump = (x: number) => {
      pos = x;
      lenis.scrollTo(x, { immediate: true, force: true });
    };
    const measure = () => {
      period = content.scrollWidth / 3;
      lenis.resize();
      jump(period);
    };

    lenis.on("scroll", ({ scroll }) => {
      if (period === 0) return;
      if (scroll < period * 0.5) jump(scroll + period);
      else if (scroll > period * 1.5) jump(scroll - period);
    });

    const observer = new ResizeObserver(measure);
    observer.observe(wrapper);
    observer.observe(content);

    let last = performance.now();
    let frame = requestAnimationFrame(function tick(time) {
      lenis.raf(time);
      if (lenis.isScrolling === "smooth") pos = lenis.scroll;
      else if (drift !== 0 && !lenis.isTouching) jump(pos + (drift * Math.min(time - last, 50)) / 1000);
      last = time;
      frame = requestAnimationFrame(tick);
    });

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      lenis.destroy();
    };
  }, [speed]);

  return (
    <div
      ref={wrapperRef}
      tabIndex={-1}
      className="overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      <div ref={contentRef} data-lenis-prevent-vertical className="flex w-max">
        {[0, 1, 2].flatMap((copy) =>
          pills.map((pill, index) => (
            <div
              key={`${copy}-${index}`}
              className="mr-2.5 inline-flex flex-none items-baseline gap-2 whitespace-nowrap rounded-full border border-border bg-surface px-3.5 py-2.5 text-[15px]"
            >
              <b className={accent ? "font-semibold text-accent" : "font-semibold"}>{pill.code}</b>
              <span className="text-muted">{pill.title}</span>
              <span className="text-sm">{pill.detail}</span>
            </div>
          )),
        )}
      </div>
    </div>
  );
}
