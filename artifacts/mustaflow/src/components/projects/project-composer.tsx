import { useId, useRef, useState } from "react";
import { ArrowRight, Lightbulb, Mic, MicOff, Monitor, Smartphone } from "lucide-react";
import { Link } from "wouter";
import { BRIEF_LIMIT } from "./project-creation-state";

type ProjectComposerProps = {
  firstName?: string | null;
  prompt: string;
  platform?: "web" | "mobile";
  onPlatformChange?: (platform: "web" | "mobile") => void;
  onPromptChange: (prompt: string) => void;
  onContinue: (prompt: string, platform: "web" | "mobile") => void;
  onBrainstorm: () => void;
  voice?: { supported: boolean; recording: boolean; language: string; toggle: () => void };
};

export function ProjectComposer({
  firstName,
  prompt,
  platform: controlledPlatform,
  onPlatformChange,
  onPromptChange,
  onContinue,
  onBrainstorm,
  voice,
}: ProjectComposerProps) {
  const promptId = useId();
  const textarea = useRef<HTMLTextAreaElement>(null);
  const [localPlatform, setLocalPlatform] = useState<"web" | "mobile">("web");
  const platform = controlledPlatform ?? localPlatform;
  const setPlatform = (value: "web" | "mobile") => {
    setLocalPlatform(value);
    onPlatformChange?.(value);
  };
  const briefTooLong = prompt.length > BRIEF_LIMIT;
  const submit = () => {
    if (prompt.trim() && !briefTooLong) onContinue(prompt.trim(), platform);
  };

  return (
    <section className="nf-composer-section" aria-labelledby="nf-composer-heading">
      <div className="nf-composer-intro">
        <p className="nf-eyebrow">
          {firstName ? "Welcome back, " + firstName : "From an idea to your app"}
        </p>
        <h1 id="nf-composer-heading">What will you make next?</h1>
        <p>Describe it in your own words. Start with an idea, then make it yours.</p>
      </div>
      <div className="nf-composer">
        <label htmlFor={promptId} className="sr-only">
          Describe your app
        </label>
        <textarea
          id={promptId}
          ref={textarea}
          value={prompt}
          onChange={(event) => onPromptChange(event.target.value)}
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              (event.ctrlKey || event.metaKey) &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              submit();
            }
          }}
          placeholder="An app for my idea, my team, or my next business..."
          rows={3}
          dir="auto"
          maxLength={BRIEF_LIMIT}
          aria-invalid={briefTooLong || undefined}
          aria-describedby={briefTooLong ? promptId + "-error" : undefined}
        />
        <div className="nf-composer-controls">
          <div className="nf-platform-choice" role="group" aria-label="App platform">
            <button
              type="button"
              aria-pressed={platform === "web"}
              onClick={() => setPlatform("web")}
            >
              <Monitor size={14} />
              Web
            </button>
            <button
              type="button"
              aria-pressed={platform === "mobile"}
              onClick={() => setPlatform("mobile")}
            >
              <Smartphone size={14} />
              Mobile
            </button>
          </div>
          <div className="nf-composer-send">
            {voice && (
              <button
                type="button"
                className="nf-icon-button"
                disabled={!voice.supported}
                aria-label={voice.recording ? "Stop voice input" : "Start voice input"}
                aria-pressed={voice.recording}
                onClick={voice.toggle}
                title={
                  voice.supported
                    ? "Voice input: " + voice.language
                    : "Voice input is not supported in this browser"
                }
              >
                {voice.recording ? <MicOff size={17} /> : <Mic size={17} />}
              </button>
            )}
            <button
              type="button"
              className="nf-primary-button"
              onClick={submit}
              disabled={!prompt.trim() || briefTooLong}
            >
              Continue <ArrowRight size={15} aria-hidden="true" />
            </button>
          </div>
        </div>
      </div>
      {briefTooLong && (
        <p id={promptId + "-error"} role="alert" className="text-sm text-destructive">
          Keep your idea within 20,000 characters so it can be saved before continuing.
        </p>
      )}
      <div className="nf-composer-footer">
        <button type="button" className="nf-quiet-link" onClick={onBrainstorm}>
          <Lightbulb size={14} />
          Brainstorm first
        </button>
        <span>Review project details before building.</span>
        {voice?.supported && (
          <Link href="/settings?tab=account#voice-input" className="nf-quiet-link">
            Voice: {voice.language}
          </Link>
        )}
      </div>
      <div className="nf-starter-ideas" aria-label="Example ideas">
        <span>Need a starting point?</span>
        {[
          [
            "A booking app",
            "A booking app for my small business, with appointments, customers, and reminders.",
          ],
          [
            "A personal website",
            "A personal website to share my work, story, and contact information.",
          ],
          [
            "A team dashboard",
            "A team dashboard to track projects, responsibilities, and upcoming deadlines.",
          ],
        ].map(([label, value]) => (
          <button
            key={label}
            type="button"
            onClick={() => {
              onPromptChange(value);
              textarea.current?.focus();
            }}
          >
            {label}
          </button>
        ))}
      </div>
    </section>
  );
}
