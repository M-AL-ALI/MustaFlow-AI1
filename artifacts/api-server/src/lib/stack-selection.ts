export function resolveInitialStackSelection(input: {
  requestedStack?: string;
  isMobilePlatform: boolean;
}): {
  stack: string;
  projectFormat: "react-vite" | "static-html";
  stackLocked: boolean;
} {
  const stack = input.isMobilePlatform ? "react-vite" : (input.requestedStack ?? "react-vite");
  return {
    stack,
    projectFormat: stack === "react-vite" && !input.isMobilePlatform ? "react-vite" : "static-html",
    stackLocked: input.isMobilePlatform || input.requestedStack !== undefined,
  };
}

export function shouldAutoDetectStack(input: {
  jobKind: "build" | "refine";
  isMobileProject: boolean;
  stackLocked: boolean;
}): boolean {
  return input.jobKind === "build" && !input.isMobileProject && !input.stackLocked;
}

export function architectureChangeMessage(input: {
  previousStack: string;
  previousFormat: string | null;
  nextStack: string;
  nextFormat: string;
}): string {
  return (
    `Auto architecture changed: stack ${input.previousStack} -> ${input.nextStack}; ` +
    `format ${input.previousFormat ?? "null"} -> ${input.nextFormat}.`
  );
}
