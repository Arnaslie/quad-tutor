/**
 * Dynamic routes are not prefetched without a loading file, so this is what
 * makes tapping a tab feel immediate rather than dead.
 */
export default function Loading() {
  return (
    <div className="flex flex-col gap-4" aria-busy="true">
      <div className="h-8 w-48 animate-pulse rounded-lg bg-surface-sunken" />
      <div className="h-24 animate-pulse rounded-2xl bg-surface-sunken" />
      <div className="h-24 animate-pulse rounded-2xl bg-surface-sunken" />
    </div>
  );
}
