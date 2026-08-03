import type { ReactNode } from "react";
import { Link } from "wouter";
import { cn } from "@/lib/utils";

export const SUPPORT_REPORT_PATH = "/help?mode=report";

export function SupportReportLink({
  children = "Report this issue",
  className,
}: {
  children?: ReactNode;
  className?: string;
}) {
  return (
    <Link
      href={SUPPORT_REPORT_PATH}
      className={cn("font-medium underline underline-offset-2 hover:text-foreground", className)}
    >
      {children}
    </Link>
  );
}

export function SupportErrorMessage({ message }: { message: ReactNode }) {
  return (
    <span>
      {message} <SupportReportLink />
    </span>
  );
}
