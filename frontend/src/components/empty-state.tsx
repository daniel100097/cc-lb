import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function EmptyState({
  icon,
  title,
  description,
  className,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  className?: string;
}) {
  return (
    <div className={cn("flex min-h-48 flex-col items-center justify-center rounded-lg border border-dashed p-6 text-center", className)}>
      <div className="text-muted-foreground mb-3 [&_svg]:size-8">{icon}</div>
      <p className="font-medium">{title}</p>
      <p className="text-muted-foreground mt-1 max-w-md text-sm">{description}</p>
    </div>
  );
}
