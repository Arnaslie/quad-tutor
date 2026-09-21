import type { ReactNode } from "react";

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-1 flex-col justify-center px-4 py-10 sm:px-6">
      <div className="mx-auto w-full max-w-sm">{children}</div>
    </div>
  );
}
