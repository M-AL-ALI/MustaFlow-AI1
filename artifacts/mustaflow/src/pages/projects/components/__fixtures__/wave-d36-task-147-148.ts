/**
 * Relevant, ordered slice of the production run-6 capture from project 44.
 *
 * These values intentionally preserve production's wire shape:
 * - command_output details are JSON in `message`, with `data: null`
 * - task 147 has no qa repair phase before its step_cap terminal event
 * - task 148 starts as an ordinary background task with no parent id in events
 */
export const task147Events = [
  {
    id: 4700,
    taskId: 147,
    eventType: "command_output",
    message:
      '{"runId":"1785359065128:node scripts/typecheck.mjs","status":"running","seq":0,"argv":["node","scripts/typecheck.mjs"],"startedAt":1785359065128}',
    filePath: null,
    data: null,
    createdAt: "2026-07-29T21:04:25.136Z",
  },
  {
    id: 4702,
    taskId: 147,
    eventType: "command_output",
    message:
      '{"runId":"1785359065128:node scripts/typecheck.mjs","status":"final","seq":1,"argv":["node","scripts/typecheck.mjs"],"exitCode":1,"durationMs":61,"stdout":"","stderr":"Error: Access to this API has been restricted. Use --allow-child-process to manage permissions.\\n  code: \'ERR_ACCESS_DENIED\',\\n  permission: \'ChildProcess\',\\n  resource: \'node_modules/.bin/tsc\'","output":"Error: Access to this API has been restricted. Use --allow-child-process to manage permissions.\\n  code: \'ERR_ACCESS_DENIED\',\\n  permission: \'ChildProcess\',\\n  resource: \'node_modules/.bin/tsc\'","truncated":false}',
    filePath: null,
    data: null,
    createdAt: "2026-07-29T21:04:25.249Z",
  },
  {
    id: 4706,
    taskId: 147,
    eventType: "command_output",
    message:
      '{"runId":"1785359102514:npx tsc --noEmit","status":"running","seq":0,"argv":["npx","tsc","--noEmit"],"startedAt":1785359102514}',
    filePath: null,
    data: null,
    createdAt: "2026-07-29T21:05:02.614Z",
  },
  {
    id: 4708,
    taskId: 147,
    eventType: "command_output",
    message:
      '{"runId":"1785359102514:npx tsc --noEmit","status":"final","seq":1,"argv":["npx","tsc","--noEmit"],"exitCode":1,"durationMs":795,"stdout":"","stderr":"npm error npx canceled due to missing packages and no YES option: [\\"tsc@2.0.4\\"]","output":"npm error npx canceled due to missing packages and no YES option: [\\"tsc@2.0.4\\"]","truncated":false}',
    filePath: null,
    data: null,
    createdAt: "2026-07-29T21:05:03.465Z",
  },
  {
    id: 4762,
    taskId: 147,
    eventType: "command_output",
    message:
      '{"runId":"1785359343832:grep -c void handleRepairCheck src/App.tsx","status":"running","seq":0,"argv":["grep","-c","void handleRepairCheck","src/App.tsx"],"startedAt":1785359343832}',
    filePath: null,
    data: null,
    createdAt: "2026-07-29T21:09:03.840Z",
  },
  {
    id: 4764,
    taskId: 147,
    eventType: "command_output",
    message:
      '{"runId":"1785359343832:grep -c void handleRepairCheck src/App.tsx","status":"final","seq":1,"argv":["grep","-c","void handleRepairCheck","src/App.tsx"],"exitCode":1,"durationMs":9,"stdout":"0\\n","stderr":"","output":"0\\n","truncated":false}',
    filePath: null,
    data: null,
    createdAt: "2026-07-29T21:09:03.901Z",
  },
  {
    id: 4770,
    taskId: 147,
    eventType: "editing_files",
    message: "AI returned 1 changed file(s).",
    filePath: null,
    data: null,
    createdAt: "2026-07-29T21:09:04.049Z",
  },
  {
    id: 4771,
    taskId: 147,
    eventType: "editing_files",
    message: "Updating src/App.tsx",
    filePath: null,
    data: null,
    createdAt: "2026-07-29T21:09:04.065Z",
  },
  {
    id: 4776,
    taskId: 147,
    eventType: "qa_step",
    message: "Starting the QA browser",
    filePath: null,
    data: { kind: "qa_tape_step", phase: "launch", status: "running" },
    createdAt: "2026-07-29T21:09:04.269Z",
  },
  {
    id: 4777,
    taskId: 147,
    eventType: "qa_step",
    message: "Opening the app",
    filePath: null,
    data: { kind: "qa_tape_step", phase: "navigation", status: "running" },
    createdAt: "2026-07-29T21:09:04.682Z",
  },
  {
    id: 4778,
    taskId: 147,
    eventType: "qa_step",
    message: "Opened the app",
    filePath: null,
    data: { kind: "qa_tape_step", phase: "navigation", status: "passed" },
    createdAt: "2026-07-29T21:09:05.482Z",
  },
  {
    id: 4779,
    taskId: 147,
    eventType: "qa_step",
    message: "Checking the browser console",
    filePath: null,
    data: { kind: "qa_tape_step", phase: "console", status: "running" },
    createdAt: "2026-07-29T21:09:05.504Z",
  },
  {
    id: 4780,
    taskId: 147,
    eventType: "qa_step",
    message: "No browser errors found",
    filePath: null,
    data: { kind: "qa_tape_step", phase: "console", status: "passed" },
    createdAt: "2026-07-29T21:09:05.670Z",
  },
  {
    id: 4785,
    taskId: 147,
    eventType: "completed",
    message: "Completed at the step limit — you can continue with a follow-up prompt.",
    filePath: null,
    data: null,
    createdAt: "2026-07-29T21:09:23.452Z",
  },
] as const;

export const task148Events = [
  {
    id: 4786,
    taskId: 148,
    eventType: "queued",
    message: "Task received, starting pipeline…",
    filePath: null,
    data: null,
    createdAt: "2026-07-29T21:09:23.688Z",
  },
  {
    id: 4787,
    taskId: 148,
    eventType: "narration",
    message: "Let me read the current project files before making any changes.",
    filePath: null,
    data: null,
    createdAt: "2026-07-29T21:09:24.362Z",
  },
  {
    id: 4788,
    taskId: 148,
    eventType: "reading_files",
    message: "Reading current project files…",
    filePath: null,
    data: null,
    createdAt: "2026-07-29T21:09:24.378Z",
  },
  {
    id: 4789,
    taskId: 148,
    eventType: "reading_files",
    message: "Loaded 14 existing file(s).",
    filePath: null,
    data: null,
    createdAt: "2026-07-29T21:09:24.409Z",
  },
  {
    id: 4790,
    taskId: 148,
    eventType: "narration",
    message: "Applying your changes to the React + Vite project now.",
    filePath: null,
    data: null,
    createdAt: "2026-07-29T21:09:24.441Z",
  },
  {
    id: 4791,
    taskId: 148,
    eventType: "generating_code",
    message: "Applying change to React + Vite project with AI…",
    filePath: null,
    data: null,
    createdAt: "2026-07-29T21:09:24.456Z",
  },
  {
    id: 4792,
    taskId: 148,
    eventType: "narration",
    message: "Agentic builder loop engaged.",
    filePath: null,
    data: null,
    createdAt: "2026-07-29T21:09:24.472Z",
  },
  {
    id: 4793,
    taskId: 148,
    eventType: "check_deferred",
    message:
      "TypeScript typecheck, Vite production build deferred because live cloud-server infrastructure is unavailable. Continuing container-free validation.",
    filePath: null,
    data: null,
    createdAt: "2026-07-29T21:09:24.561Z",
  },
  {
    id: 4794,
    taskId: 148,
    eventType: "loop:step",
    message:
      '{"stepIndex":1,"stepCap":25,"wallClockElapsedMs":89,"wallClockBudgetMs":1200000,"toolName":null}',
    filePath: null,
    data: null,
    createdAt: "2026-07-29T21:09:24.607Z",
  },
] as const;

export const task147AfterReportLink = {
  id: 147,
  projectId: 44,
  title: "Run repair check",
  kind: "main",
  status: "completed",
  completionKind: "step_cap",
  report: {
    userRequest: "Run the repair check.",
    filesCreated: ["src/App.tsx"],
    warnings: ["Agent loop terminated: step-cap"],
    versionId: 85,
    architectReview: {
      autoFixQueued: true,
      autoFixTaskId: 148,
    },
  },
} as const;

export const task148Captured = {
  id: 148,
  projectId: 44,
  title: "Architect Auto-fix: TypeScript check failed",
  kind: "background",
  status: "building",
  completionKind: null,
  report: null,
} as const;
