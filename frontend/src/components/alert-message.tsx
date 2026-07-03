import { AlertCircle } from "lucide-react";

export function AlertMessage({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div className="border-destructive/30 bg-destructive/10 text-destructive flex items-start gap-2 rounded-md border px-3 py-2 text-sm">
      <AlertCircle className="mt-0.5 size-4 shrink-0" />
      <span>{message}</span>
    </div>
  );
}
