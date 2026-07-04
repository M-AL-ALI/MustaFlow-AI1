import { Bot, FileText, Mic, ImageIcon, Paperclip } from "lucide-react";

export function OraChatMockup() {
  return (
    <div className="rounded-2xl border border-border bg-card shadow-xl overflow-hidden">
      {/* Top bar */}
      <div className="flex items-center gap-2.5 px-4 py-3 border-b border-border bg-muted/30">
        <div className="relative flex h-7 w-7 items-center justify-center rounded-full bg-[hsl(265_85%_65%/0.15)] border border-[hsl(265_85%_65%/0.3)]">
          <Bot className="h-3.5 w-3.5 text-[hsl(265_85%_65%)]" />
          <span className="absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full bg-green-500 border-2 border-card" />
        </div>
        <span className="text-sm font-semibold text-foreground">Ora</span>
        <span className="ml-auto text-[10px] text-green-500 font-medium tracking-wide">Online</span>
      </div>

      {/* Feed */}
      <div className="px-4 py-5 space-y-4">
        {/* User turn 1 */}
        <div className="flex justify-end">
          <div className="bg-primary text-primary-foreground rounded-2xl rounded-br-sm px-3.5 py-2.5 max-w-[76%] text-[13px] leading-snug">
            What should I focus on to grow my SaaS?
          </div>
        </div>

        {/* Ora reply 1 */}
        <div className="flex items-start gap-2.5">
          <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[hsl(265_85%_65%/0.12)] border border-[hsl(265_85%_65%/0.25)] mt-0.5">
            <Bot className="h-3 w-3 text-[hsl(265_85%_65%)]" />
          </div>
          <div className="bg-muted text-foreground rounded-2xl rounded-bl-sm px-3.5 py-3 max-w-[82%] text-[13px] leading-relaxed">
            <p className="mb-2">Three levers that compound fast:</p>
            <div className="space-y-1.5">
              <div className="flex gap-2">
                <span className="font-semibold shrink-0">Retention</span>
                <span className="text-muted-foreground">cut churn before scaling acquisition</span>
              </div>
              <div className="flex gap-2">
                <span className="font-semibold shrink-0">Activation</span>
                <span className="text-muted-foreground">get users to their "aha" moment faster</span>
              </div>
              <div className="flex gap-2">
                <span className="font-semibold shrink-0">Expansion</span>
                <span className="text-muted-foreground">upsell once trust is established</span>
              </div>
            </div>
          </div>
        </div>

        {/* User turn 2 */}
        <div className="flex justify-end">
          <div className="bg-primary text-primary-foreground rounded-2xl rounded-br-sm px-3.5 py-2.5 max-w-[76%] text-[13px] leading-snug">
            Can you export that as a doc?
          </div>
        </div>

        {/* Ora reply 2 */}
        <div className="flex items-start gap-2.5">
          <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[hsl(265_85%_65%/0.12)] border border-[hsl(265_85%_65%/0.25)] mt-0.5">
            <Bot className="h-3 w-3 text-[hsl(265_85%_65%)]" />
          </div>
          <div className="bg-muted text-foreground rounded-2xl rounded-bl-sm px-3.5 py-3 max-w-[82%] text-[13px]">
            <p className="mb-2.5 leading-relaxed">Done — here's your report:</p>
            <div className="flex items-center gap-2.5 bg-card border border-border rounded-xl px-3 py-2 w-fit">
              <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-amber-500/10 border border-amber-500/20">
                <FileText className="h-3.5 w-3.5 text-amber-500" />
              </div>
              <div>
                <p className="text-xs font-medium text-foreground leading-none">Report.docx</p>
                <p className="text-[10px] text-muted-foreground mt-0.5">Ready to download</p>
              </div>
            </div>
          </div>
        </div>

        {/* Typing indicator */}
        <div className="flex items-start gap-2.5">
          <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[hsl(265_85%_65%/0.12)] border border-[hsl(265_85%_65%/0.25)]">
            <Bot className="h-3 w-3 text-[hsl(265_85%_65%)]" />
          </div>
          <div className="bg-muted rounded-2xl rounded-bl-sm px-4 py-3">
            <div className="flex items-center gap-1">
              <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/50 animate-bounce [animation-delay:0ms]" />
              <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/50 animate-bounce [animation-delay:150ms]" />
              <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/50 animate-bounce [animation-delay:300ms]" />
            </div>
          </div>
        </div>
      </div>

      {/* Input row */}
      <div className="px-4 pb-4">
        <div className="flex items-center gap-2 rounded-xl border border-border bg-background px-3.5 py-2.5">
          <span className="flex-1 text-[12px] text-muted-foreground/40 select-none">
            Ask anything…
          </span>
          <div className="flex items-center gap-2.5 text-muted-foreground/40">
            <ImageIcon className="h-3.5 w-3.5" />
            <Mic className="h-3.5 w-3.5" />
            <Paperclip className="h-3.5 w-3.5" />
          </div>
        </div>
      </div>
    </div>
  );
}
