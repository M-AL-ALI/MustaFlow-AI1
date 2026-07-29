import { Pencil } from "lucide-react";
import { cn } from "@/lib/utils";

export type EditableMessage = {
  id: number;
  role: string;
  content: string;
};

export function latestUserMessageId(messages: EditableMessage[] | undefined): number | null {
  if (!messages) return null;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") return messages[index].id;
  }
  return null;
}

export function EditAndResend({ onEdit, className }: { onEdit: () => void; className?: string }) {
  return (
    <button
      type="button"
      onClick={onEdit}
      className={cn(
        "inline-flex items-center gap-1 rounded-sm px-1 py-0.5 text-[10px] opacity-70 outline-none transition-opacity hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
      aria-label="Edit and resend this message"
    >
      <Pencil className="h-2.5 w-2.5" aria-hidden="true" />
      Edit &amp; resend
    </button>
  );
}
