import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { useLocation, useSearch } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useCreateProject,
  getListProjectsQueryKey,
  getGetProjectQueryKey,
  getGetProjectsSummaryQueryKey,
  getGetRecentActivityQueryKey,
} from "@workspace/api-client-react";
import { ArrowLeft, ArrowRight, LayoutTemplate, Monitor, Smartphone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { TemplatePicker } from "@/components/template-picker";
import { useWorkspace } from "@/contexts/workspace-context";
import { useClerkUser } from "@/lib/clerk-safe";
import {
  createProjectReviewAccountFence,
  type ProjectReviewAccountFence,
} from "@/lib/project-review-account-fence";
import {
  claimCreationDraft,
  readCreationDraft,
  clearCreationDraft,
  type CreationDraft,
} from "@/lib/creation-draft";
import { TEMPLATES, STARTER_PACKS, type TemplateDefinition } from "@/lib/templates";
import { cn } from "@/lib/utils";
import {
  BRIEF_LIMIT,
  CREATION_STACKS,
  clearProjectReviewDraft,
  isCreationKind,
  projectCreationInput,
  projectReviewDestination,
  readProjectReviewDraft,
  saveProjectReviewDraft,
  suggestProjectName,
  type CreationValues,
} from "@/components/projects/project-creation-state";

// Persist the destination alongside review values. The shared draft serializer keeps
// these values intact, while projectCreationInput sends only its explicit fields.
type WorkspaceReviewValues = CreationValues & {
  workspaceId?: number | null;
  handoffWorkspaceId?: number | null;
};

function retainedWorkspaceId(values: CreationValues): number | null | undefined {
  const id: unknown = (values as WorkspaceReviewValues).workspaceId;
  if (id === undefined) return undefined; // Legacy drafts bind on first ready selection.
  return typeof id === "number" && Number.isSafeInteger(id) && id > 0 ? id : null;
}

const ALL_TEMPLATES = [...TEMPLATES, ...STARTER_PACKS];
const ENTRY_PARAMS = ["draft", "draftId", "workspaceId", "prompt", "platform", "template"];
const WEB_TYPES = [
  ["web", "Website"],
  ["fullstack", "Web app"],
  ["dashboard", "Dashboard"],
  ["automation", "Automation"],
  ["api", "API"],
] as const;
const STACK_LABELS: Record<CreationValues["stack"], string> = {
  "react-vite": "React + Vite",
  nextjs: "Next.js",
  "node-api": "Node.js API",
  "python-flask": "Python Flask",
  "python-fastapi": "FastAPI",
  "go-gin": "Go + Gin",
};
const selectClass = "h-10 w-full rounded-md border border-input bg-background px-3 text-sm";
const unsupportedTemplate =
  "This template's project type is not supported by project creation yet. Your brief is unchanged; choose another template.";

function requestedWorkspace(params: URLSearchParams, key: string): number | null | undefined {
  const values = params.getAll(key);
  if (values.length === 0) return undefined;
  if (values.length !== 1 || !/^[1-9][0-9]*$/.test(values[0]!)) return null;
  const id = Number(values[0]);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function initialReview(ownerId: string, arrival: CreationDraft | null, params: URLSearchParams) {
  const explicitScope = requestedWorkspace(params, "reviewWorkspaceId");
  const scope =
    explicitScope === undefined && params.get("draft") === "1"
      ? requestedWorkspace(params, "workspaceId")
      : explicitScope;
  const buildDraft =
    arrival?.intent === "build" &&
    arrival.accountId === ownerId &&
    typeof arrival.workspaceId === "number" &&
    Number.isSafeInteger(arrival.workspaceId) &&
    arrival.workspaceId > 0 &&
    (scope === undefined || scope === arrival.workspaceId)
      ? arrival
      : null;
  const saved =
    scope === null ? null : readProjectReviewDraft(ownerId, buildDraft?.workspaceId ?? scope);
  const hasEntry = ENTRY_PARAMS.some((key) => params.has(key));
  if (
    saved &&
    (!hasEntry ||
      (buildDraft && saved.sourceDraftId === buildDraft.id) ||
      (!buildDraft &&
        params.get("draft") === "1" &&
        !params.has("prompt") &&
        !params.has("template")))
  ) {
    const sourceId = (saved.values as WorkspaceReviewValues).handoffWorkspaceId;
    return {
      values: saved.values,
      reviewId: saved.id,
      sourceDraftId: saved.sourceDraftId,
      sourceWorkspaceId:
        typeof sourceId === "number" && Number.isSafeInteger(sourceId) && sourceId > 0
          ? sourceId
          : null,
      notice:
        !buildDraft && params.get("draft") === "1"
          ? "Your saved idea is unavailable for this account and workspace. Your existing review is unchanged."
          : "",
    };
  }
  const candidate = ALL_TEMPLATES.find((template) => template.id === params.get("template"));
  const template = candidate && isCreationKind(candidate.projectKind) ? candidate : undefined;
  const platform = template
    ? template.projectKind === "mobile-cross"
      ? "mobile"
      : "web"
    : (buildDraft?.platform ?? params.get("platform")) === "mobile"
      ? "mobile"
      : "web";
  const prompt = buildDraft?.prompt ?? params.get("prompt") ?? template?.seedPrompt ?? "";
  const values: WorkspaceReviewValues = {
    workspaceId: buildDraft?.workspaceId ?? scope,
    handoffWorkspaceId: buildDraft?.workspaceId ?? undefined,
    prompt,
    name: template && prompt === template.seedPrompt ? template.title : suggestProjectName(prompt),
    nameEdited: false,
    platform,
    kind:
      template && isCreationKind(template.projectKind)
        ? template.projectKind
        : platform === "mobile"
          ? "mobile-cross"
          : "web",
    stack: "react-vite",
    appMode: "simple",
    templateId: template?.id ?? null,
  };
  const notice =
    candidate && !template
      ? unsupportedTemplate
      : params.has("template") && !candidate
        ? "This template is unavailable. You can describe your project below."
        : params.get("draft") === "1" && !buildDraft
          ? "Your saved idea is unavailable or has expired. Add a brief or project name to begin."
          : "";
  return {
    values,
    reviewId: null,
    sourceDraftId: buildDraft?.id ?? null,
    sourceWorkspaceId: buildDraft?.workspaceId ?? null,
    notice,
  };
}

export default function NewProjectPage() {
  const { user, isLoaded, isSignedIn } = useClerkUser();
  const search = useSearch();
  const scope = requestedWorkspace(new URLSearchParams(search), "reviewWorkspaceId");
  const entryKey = scope === undefined ? "legacy" : scope === null ? "invalid" : scope;
  if (!isLoaded) {
    return (
      <p role="status" className="px-4 py-8 text-sm text-muted-foreground">
        Loading your account...
      </p>
    );
  }
  if (!isSignedIn || !user?.id) {
    return (
      <p role="status" className="px-4 py-8 text-sm text-muted-foreground">
        Sign in to review your project.
      </p>
    );
  }
  return <AccountProjectReview key={JSON.stringify([user.id, entryKey])} ownerId={user.id} />;
}

function AccountProjectReview({ ownerId }: { ownerId: string }) {
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const createProject = useCreateProject({ mutation: { retry: false } });
  const { currentWorkspace, workspaces, hasChosenWorkspace, isLoading, isError, retryWorkspaces } =
    useWorkspace();
  const ownedWorkspaces = useMemo(
    () =>
      workspaces.filter(
        (workspace) =>
          workspace.ownerUserId === ownerId &&
          !workspace.deletedAt &&
          Number.isSafeInteger(workspace.id) &&
          workspace.id > 0,
      ),
    [workspaces, ownerId],
  );
  const selectedWorkspace = ownedWorkspaces.find(
    (workspace) => workspace.id === currentWorkspace?.id,
  );
  const selectableWorkspaceId =
    hasChosenWorkspace && !isLoading && !isError ? selectedWorkspace?.id : undefined;
  const [entryParams] = useState(
    () => new URLSearchParams(typeof window === "undefined" ? "" : window.location.search),
  );
  const [initial, setInitial] = useState(() => initialReview(ownerId, null, entryParams));
  const [arrivalPending, setArrivalPending] = useState(entryParams.get("draft") === "1");
  const [values, setValues] = useState<WorkspaceReviewValues>(() => {
    const retainedId = retainedWorkspaceId(initial.values);
    return {
      ...initial.values,
      workspaceId: retainedId === undefined ? selectableWorkspaceId : retainedId,
    };
  });
  const draftWorkspace = ownedWorkspaces.find((workspace) => workspace.id === values.workspaceId);
  const hasDraftWorkspace = Boolean(draftWorkspace);
  const [notice, setNotice] = useState(initial.notice);
  const [view, setView] = useState<"form" | "templates">("form");
  const [saved, setSaved] = useState(false);
  const [pending, setPending] = useState(false);
  const [principalReady, setPrincipalReady] = useState(false);
  const [submittedWorkspace, setSubmittedWorkspace] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [reviewConflict, setReviewConflict] = useState<{ id: number; name: string } | null>(null);
  const [created, setCreated] = useState<{ id: number; name: string } | null>(null);
  const submitting = useRef(false);
  const mounted = useRef(false);
  const activeSubmission = useRef<object | null>(null);
  const accountFence = useRef<ProjectReviewAccountFence | null>(null);
  const savedReviewId = useRef<string | null>(initial.reviewId);
  const nameInput = useRef<HTMLInputElement>(null);
  const selectedTemplate = ALL_TEMPLATES.find((template) => template.id === values.templateId);

  const hasCurrentAccount = useCallback(() => {
    // A sidebar entry change fences late responses even before React commits its remount.
    const currentScope =
      typeof window === "undefined"
        ? requestedWorkspace(entryParams, "reviewWorkspaceId")
        : requestedWorkspace(new URLSearchParams(window.location.search), "reviewWorkspaceId");
    return (
      mounted.current &&
      accountFence.current?.isCurrent() === true &&
      currentScope === requestedWorkspace(entryParams, "reviewWorkspaceId")
    );
  }, [entryParams]);

  useLayoutEffect(() => {
    mounted.current = true;
    const fence = createProjectReviewAccountFence(ownerId, () => {
      activeSubmission.current = null;
      if (mounted.current) setPrincipalReady(false);
    });
    accountFence.current = fence;
    setPrincipalReady(fence.isCurrent());
    return () => {
      mounted.current = false;
      activeSubmission.current = null;
      accountFence.current = null;
      fence.dispose();
    };
  }, [ownerId]);

  useEffect(() => {
    if (!arrivalPending || !hasCurrentAccount()) return;
    const expectedId = entryParams.get("draftId");
    const finish = (arrival: CreationDraft | null) => {
      const accepted =
        arrival && (expectedId === null || expectedId === arrival.id) ? arrival : null;
      const restored = initialReview(ownerId, accepted, entryParams);
      const retainedId = retainedWorkspaceId(restored.values);
      setInitial(restored);
      savedReviewId.current = restored.reviewId;
      setValues({
        ...restored.values,
        workspaceId: retainedId === undefined ? selectableWorkspaceId : retainedId,
      });
      setNotice(restored.notice);
      setArrivalPending(false);
      // Preserve the durable destination even if saving the editable review fails.
      if (accepted?.workspaceId != null && typeof window !== "undefined") {
        try {
          const url = new URL(window.location.href);
          url.searchParams.set("workspaceId", String(accepted.workspaceId));
          url.searchParams.set("draftId", accepted.id);
          window.history.replaceState(
            window.history.state,
            "",
            url.pathname + url.search + url.hash,
          );
        } catch {
          /* The bound receipt remains available in scoped tab storage. */
        }
      }
    };
    if (entryParams.has("workspaceId")) {
      if (isLoading || isError) return;
      const rawId = entryParams.get("workspaceId")!;
      const id = /^[1-9]\d*$/.test(rawId) ? Number(rawId) : NaN;
      if (!Number.isSafeInteger(id) || !ownedWorkspaces.some((workspace) => workspace.id === id)) {
        finish(null);
        return;
      }
      finish(readCreationDraft({ accountId: ownerId, workspaceId: id }));
      return;
    }
    const unassigned = claimCreationDraft(
      { accountId: ownerId, workspaceId: null },
      expectedId ?? undefined,
    );
    if (!unassigned) {
      finish(null);
      return;
    }
    if (selectableWorkspaceId === undefined) return;
    finish(
      claimCreationDraft(
        { accountId: ownerId, workspaceId: selectableWorkspaceId },
        expectedId ?? undefined,
      ),
    );
  }, [
    arrivalPending,
    ownedWorkspaces,
    ownerId,
    entryParams,
    selectableWorkspaceId,
    isLoading,
    isError,
    principalReady,
    hasCurrentAccount,
  ]);

  useEffect(() => {
    if (!hasCurrentAccount() || submitting.current || selectableWorkspaceId === undefined) return;
    setValues((previous) =>
      previous.workspaceId === undefined
        ? { ...previous, workspaceId: selectableWorkspaceId }
        : previous,
    );
  }, [selectableWorkspaceId, ownerId, hasCurrentAccount]);

  useEffect(() => {
    if (
      !mounted.current ||
      !accountFence.current?.isCurrent() ||
      submitting.current ||
      arrivalPending
    )
      return;
    if (values.workspaceId !== undefined && (isLoading || isError || !hasDraftWorkspace)) {
      setSaved(false);
      return;
    }
    const draft = saveProjectReviewDraft(
      ownerId,
      values,
      initial.sourceDraftId,
      savedReviewId.current ?? undefined,
    );
    if (draft) savedReviewId.current = draft.id;
    setSaved(Boolean(draft));
    // Remove only consumed hints, and only after their editable replacement is saved.
    if (draft && typeof window !== "undefined") {
      const url = new URL(window.location.href);
      ENTRY_PARAMS.forEach((key) => url.searchParams.delete(key));
      if (url.href !== window.location.href) {
        window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
      }
    }
  }, [
    values,
    initial.sourceDraftId,
    ownerId,
    arrivalPending,
    isLoading,
    isError,
    hasDraftWorkspace,
  ]);

  function changePrompt(prompt: string) {
    setValues((previous) => ({
      ...previous,
      prompt,
      name: previous.nameEdited ? previous.name : suggestProjectName(prompt),
    }));
  }

  function changePlatform(platform: CreationValues["platform"]) {
    if (platform === values.platform) return;
    setValues((previous) => ({
      ...previous,
      platform,
      kind: platform === "mobile" ? "mobile-cross" : "web",
      templateId: null,
    }));
  }

  function applyTemplate(template: TemplateDefinition) {
    const kind = template.projectKind;
    if (!isCreationKind(kind)) {
      setNotice(unsupportedTemplate);
      setView("form");
      return;
    }
    setValues((previous) => {
      const useSeed = !previous.prompt.trim() || previous.prompt === selectedTemplate?.seedPrompt;
      return {
        ...previous,
        prompt: useSeed ? template.seedPrompt : previous.prompt,
        name: previous.nameEdited
          ? previous.name
          : useSeed
            ? template.title
            : suggestProjectName(previous.prompt),
        templateId: template.id,
        kind,
        platform: kind === "mobile-cross" ? "mobile" : "web",
        stack: "react-vite",
      };
    });
    setNotice("");
    setView("form");
  }

  function openSavedReview(workspaceId: number, replace = false) {
    if (!hasCurrentAccount()) return;
    try {
      if (replace) setLocation(projectReviewDestination(workspaceId), { replace: true });
      else setLocation(projectReviewDestination(workspaceId));
    } catch {
      if (hasCurrentAccount()) {
        setError(
          "Your saved reviews are still available. Use New project in the selected workspace to reopen its review.",
        );
      }
    }
  }

  function openWorkspace(id: number) {
    if (!hasCurrentAccount()) return;
    try {
      setLocation("/projects/" + id, { replace: true });
    } catch {
      if (!hasCurrentAccount()) return;
      if (mounted.current) setError("Your project was created. Use Open workspace to continue.");
    }
  }

  function recoverCurrent(message: string) {
    if (!hasCurrentAccount()) return;
    activeSubmission.current = null;
    submitting.current = false;
    setPending(false);
    setSubmittedWorkspace(null);
    setError(message);
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!hasCurrentAccount()) return;
    if (submitting.current || createProject.isPending || created) return;
    if (arrivalPending || isLoading || isError || !draftWorkspace) {
      setError("Choose an available workspace for this draft before creating the project.");
      return;
    }
    if (!values.name.trim()) {
      setError("Give your project a name before creating it.");
      nameInput.current?.focus();
      return;
    }
    if (values.prompt.length > BRIEF_LIMIT) {
      setError("Keep your brief within 20,000 characters before creating the project.");
      return;
    }
    submitting.current = true;
    setPending(true);
    setSubmittedWorkspace(draftWorkspace.name);
    setError("");
    const reviewId = savedReviewId.current;
    const submittedOwnerId = ownerId;
    const sourceDraftId = initial.sourceDraftId;
    const sourceWorkspaceId = initial.sourceWorkspaceId;
    const submission = {};
    activeSubmission.current = submission;
    const isCurrentSubmission = () =>
      hasCurrentAccount() && activeSubmission.current === submission;
    const recover = (message: string) => {
      if (isCurrentSubmission()) recoverCurrent(message);
    };
    createProject.mutate(
      { data: projectCreationInput(values, draftWorkspace.id) },
      {
        onSuccess: (project) => {
          if (!isCurrentSubmission()) return;
          if (!project || !Number.isSafeInteger(project.id) || project.id <= 0) {
            recover(
              "The server response did not confirm a project. Check your projects before trying again.",
            );
            return;
          }
          setCreated({ id: project.id, name: project.name });
          if (reviewId) clearProjectReviewDraft(submittedOwnerId, reviewId);
          if (sourceDraftId && sourceWorkspaceId !== null) {
            clearCreationDraft(sourceDraftId, {
              accountId: submittedOwnerId,
              workspaceId: sourceWorkspaceId,
            });
          }
          // Cache refresh failures must never turn a confirmed creation into a retry.
          try {
            queryClient.setQueryData(getGetProjectQueryKey(project.id), project);
            for (const queryKey of [
              getListProjectsQueryKey(),
              getGetProjectsSummaryQueryKey(),
              getGetRecentActivityQueryKey(),
            ]) {
              if (!isCurrentSubmission()) return;
              void queryClient.invalidateQueries({ queryKey }).catch(() => undefined);
            }
          } catch {
            // The workspace can fetch the confirmed project independently.
          }
          if (isCurrentSubmission()) openWorkspace(project.id);
        },
        onError: (cause: unknown) =>
          recover(
            cause instanceof Error && cause.message
              ? cause.message
              : "Could not create your project. Please try again.",
          ),
      },
    );
  }

  if (created) {
    return (
      <div className="nabuflow-shell mx-auto w-full max-w-2xl px-4 py-10">
        <p role="status" className="mb-2 text-sm text-muted-foreground">
          Project created
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">{created.name}</h1>
        <p className="my-4 text-sm text-muted-foreground">
          Your project is ready to open. Follow build progress and continue editing in its
          workspace.
        </p>
        {error && (
          <p role="alert" className="mb-4 text-sm">
            {error}
          </p>
        )}
        <Button onClick={() => openWorkspace(created.id)} className="gap-2">
          Open workspace <ArrowRight className="h-4 w-4" aria-hidden="true" />
        </Button>
      </div>
    );
  }

  if (view === "templates") {
    return (
      <div className="nabuflow-shell mx-auto w-full max-w-4xl px-4 py-8">
        <button type="button" onClick={() => setView("form")} className="nf-quiet-link mb-6">
          <ArrowLeft className="h-4 w-4" aria-hidden="true" /> Back to project details
        </button>
        <h1 className="mb-2 text-2xl font-semibold tracking-tight">Choose a starting point</h1>
        <p className="mb-6 text-sm text-muted-foreground">
          Templates fill an empty brief. Your own wording and custom project name stay in place.
        </p>
        <TemplatePicker
          selectedId={selectedTemplate?.id}
          onSelect={applyTemplate}
          onStartFromScratch={() => {
            setValues((previous) => ({ ...previous, templateId: null }));
            setView("form");
          }}
          filterPlatform={values.platform}
        />
      </div>
    );
  }

  const busy = pending || createProject.isPending;
  const workspaceReady =
    principalReady && !arrivalPending && !isLoading && !isError && Boolean(draftWorkspace);
  return (
    <div className="nabuflow-shell mx-auto w-full max-w-2xl px-4 py-8 text-foreground">
      <button
        type="button"
        disabled={busy}
        onClick={() => setLocation("/projects")}
        className="nf-quiet-link mb-6"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden="true" /> Back to projects
      </button>
      <div className="mb-7">
        <p className="nf-eyebrow">NabuFlow / New project</p>
        <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">
          Make your idea a project
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Review your brief, give it a name, and choose where it will run.
        </p>
      </div>
      {notice && (
        <p role="status" className="mb-5 rounded-lg border border-border p-3 text-sm">
          {notice}
        </p>
      )}
      {!principalReady && (
        <p role="status" className="mb-4 text-sm text-muted-foreground">
          Your account changed or is unavailable. Wait for the page to update, or reload it.
        </p>
      )}
      <form onSubmit={handleSubmit} aria-label="Create project" aria-busy={busy}>
        <div className="min-w-0 space-y-6">
          <div className="rounded-lg border border-border px-3 py-2 text-sm">
            {busy && submittedWorkspace ? (
              <p>Creating in {submittedWorkspace}</p>
            ) : isLoading ? (
              <p role="status">Loading workspaces...</p>
            ) : isError ? (
              <div role="alert" className="flex flex-wrap items-center justify-between gap-2">
                <p>Workspaces could not be loaded. Your brief is still here.</p>
                <button
                  type="button"
                  className="nf-quiet-link"
                  disabled={busy || !principalReady}
                  onClick={() => {
                    if (!hasCurrentAccount() || busy) return;
                    void Promise.resolve(retryWorkspaces()).catch(() => undefined);
                  }}
                >
                  Retry workspaces
                </button>
              </div>
            ) : arrivalPending ? (
              <p role="status">
                Choose a workspace from the sidebar to assign this saved idea. Your idea stays
                private to this account.
              </p>
            ) : (
              <div className="space-y-2">
                {draftWorkspace ? (
                  <p>
                    Workspace: <span className="font-medium">{draftWorkspace.name}</span>
                  </p>
                ) : (
                  <p role="status">
                    {values.workspaceId === undefined
                      ? "Choose or create a workspace using the workspace switcher to continue."
                      : "This draft's workspace is unavailable. Choose another workspace explicitly; your brief is unchanged."}
                  </p>
                )}
                {selectedWorkspace && selectedWorkspace.id !== values.workspaceId && (
                  <div className="space-y-2">
                    <p className="text-muted-foreground">
                      Changing the sidebar workspace does not move this draft.
                    </p>
                    <button
                      type="button"
                      className="nf-quiet-link"
                      disabled={busy || !principalReady}
                      onClick={() => {
                        if (!hasCurrentAccount() || submitting.current || createProject.isPending)
                          return;
                        const target = readProjectReviewDraft(ownerId, selectedWorkspace.id);
                        if (target && target.id !== savedReviewId.current) {
                          setReviewConflict({
                            id: selectedWorkspace.id,
                            name: selectedWorkspace.name,
                          });
                          setError(
                            "That workspace already has a saved project review. Open it instead, or finish it before moving this draft. Both reviews are unchanged.",
                          );
                          return;
                        }
                        const moved = { ...values, workspaceId: selectedWorkspace.id };
                        const receipt = saveProjectReviewDraft(
                          ownerId,
                          moved,
                          initial.sourceDraftId,
                          savedReviewId.current ?? undefined,
                        );
                        if (!receipt) {
                          setError(
                            "Could not save this move. Your draft and its workspace are unchanged. Please try again.",
                          );
                          return;
                        }
                        savedReviewId.current = receipt.id;
                        setValues(moved);
                        setSaved(true);
                        setReviewConflict(null);
                        setError("");
                        if (entryParams.has("reviewWorkspaceId")) {
                          openSavedReview(selectedWorkspace.id, true);
                        }
                      }}
                    >
                      Use {selectedWorkspace.name} for this draft
                    </button>
                    {reviewConflict?.id === selectedWorkspace.id && (
                      <button
                        type="button"
                        className="nf-quiet-link"
                        disabled={busy || !principalReady}
                        onClick={() => {
                          if (!hasCurrentAccount() || submitting.current || createProject.isPending)
                            return;
                          openSavedReview(reviewConflict.id);
                        }}
                      >
                        Open saved review in {reviewConflict.name}
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
          <fieldset
            disabled={busy || !principalReady || arrivalPending}
            className="min-w-0 space-y-6"
          >
            <div className="space-y-2">
              <Label htmlFor="np-prompt">Project brief</Label>
              <Textarea
                id="np-prompt"
                value={values.prompt}
                onChange={(event) => changePrompt(event.target.value)}
                placeholder="A booking app for my studio, with appointments and reminders."
                rows={5}
                dir="auto"
                maxLength={BRIEF_LIMIT}
                aria-describedby="np-brief-help"
                className="resize-y"
              />
              <p id="np-brief-help" className="text-xs text-muted-foreground">
                A brief starts the first build. You can also create a named project and add a brief
                in its workspace.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="np-name">Project name</Label>
              <Input
                id="np-name"
                ref={nameInput}
                value={values.name}
                onChange={(event) =>
                  setValues((previous) => ({
                    ...previous,
                    name: event.target.value,
                    nameEdited: true,
                  }))
                }
                placeholder="Choose a project name"
                dir="auto"
                aria-describedby="np-name-help"
              />
              <p id="np-name-help" className="text-xs text-muted-foreground">
                This is the name you will see in your projects and workspace. Edit the suggestion
                freely.
              </p>
            </div>
            <div className="space-y-2">
              <Label>Build for</Label>
              <div
                role="group"
                aria-label="App platform"
                className="flex gap-2 rounded-lg border border-border bg-muted p-1"
              >
                {(["web", "mobile"] as const).map((platform) => {
                  const Icon = platform === "web" ? Monitor : Smartphone;
                  return (
                    <button
                      key={platform}
                      type="button"
                      aria-pressed={values.platform === platform}
                      onClick={() => changePlatform(platform)}
                      className={cn(
                        "flex flex-1 items-center justify-center gap-2 rounded-md px-3 py-2 text-sm",
                        values.platform === platform
                          ? "bg-background text-foreground shadow-sm"
                          : "text-muted-foreground",
                      )}
                    >
                      <Icon className="h-4 w-4" aria-hidden="true" />{" "}
                      {platform === "web" ? "Web" : "Mobile"}
                    </button>
                  );
                })}
              </div>
              {values.platform === "mobile" && (
                <p className="text-xs text-muted-foreground">
                  Mobile targets iOS and Android using Expo / React Native. Device previews depend
                  on the workspace runtime.
                </p>
              )}
            </div>
            <details className="rounded-xl border border-border">
              <summary className="cursor-pointer px-4 py-3 text-sm font-medium">
                Starting point and advanced options
              </summary>
              <div className="space-y-5 border-t border-border p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <span className="text-sm">
                    {selectedTemplate?.title ?? "Start with your own brief"}
                  </span>
                  <div className="flex gap-3">
                    <button
                      type="button"
                      onClick={() => setView("templates")}
                      className="nf-quiet-link"
                    >
                      <LayoutTemplate className="h-4 w-4" aria-hidden="true" />{" "}
                      {selectedTemplate ? "Change template" : "Browse templates"}
                    </button>
                    {selectedTemplate && (
                      <button
                        type="button"
                        className="nf-quiet-link"
                        onClick={() => setValues((previous) => ({ ...previous, templateId: null }))}
                      >
                        Remove template
                      </button>
                    )}
                  </div>
                </div>
                {values.platform === "web" && (
                  <>
                    <div className="space-y-2">
                      <Label htmlFor="np-mode">Build setup</Label>
                      <select
                        id="np-mode"
                        className={selectClass}
                        value={values.appMode}
                        onChange={(event) =>
                          setValues((previous) => ({
                            ...previous,
                            appMode: event.target.value === "fullstack" ? "fullstack" : "simple",
                          }))
                        }
                      >
                        <option value="simple">Simple app</option>
                        <option value="fullstack">Full-stack app</option>
                      </select>
                      <p className="text-xs text-muted-foreground">
                        {values.appMode === "fullstack"
                          ? "Requests server and database setup where available. Track setup status in the workspace."
                          : "Static site or client-side app without automatic server provisioning."}
                      </p>
                    </div>
                    <div className="grid gap-4 sm:grid-cols-2">
                      <div className="space-y-2">
                        <Label htmlFor="np-stack">Stack</Label>
                        <select
                          id="np-stack"
                          className={selectClass}
                          value={values.stack}
                          onChange={(event) => {
                            const stack = CREATION_STACKS.find(
                              (value) => value === event.target.value,
                            );
                            if (stack) setValues((previous) => ({ ...previous, stack }));
                          }}
                        >
                          {CREATION_STACKS.map((stack) => (
                            <option key={stack} value={stack}>
                              {STACK_LABELS[stack]}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="np-kind">Project type</Label>
                        <select
                          id="np-kind"
                          className={selectClass}
                          value={values.kind}
                          onChange={(event) => {
                            const kind = WEB_TYPES.find(
                              ([value]) => value === event.target.value,
                            )?.[0];
                            if (kind)
                              setValues((previous) => ({ ...previous, kind, templateId: null }));
                          }}
                        >
                          {WEB_TYPES.map(([kind, label]) => (
                            <option key={kind} value={kind}>
                              {label}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>
                  </>
                )}
              </div>
            </details>
            <p role="status" className="text-xs text-muted-foreground">
              {saved
                ? "Draft kept in this tab for 30 minutes after your last edit."
                : "Your edits are only on this page. Tab storage is unavailable; keep this page open until creation finishes."}
            </p>
            {error && (
              <div
                role="alert"
                className="space-y-2 rounded-lg border border-destructive/40 p-3 text-sm"
              >
                <p>{error}</p>
                <p className="text-muted-foreground">
                  Your details are still here. If the request was interrupted, check your projects
                  before retrying.
                </p>
              </div>
            )}
            <div className="flex flex-col gap-4 border-t border-border pt-5 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-xs text-muted-foreground">
                After creation, your project workspace opens with its build progress and editing
                tools.
              </p>
              <Button
                type="submit"
                disabled={
                  busy ||
                  !workspaceReady ||
                  !values.name.trim() ||
                  values.prompt.length > BRIEF_LIMIT
                }
                className="shrink-0 gap-2"
              >
                {busy ? "Creating project..." : "Create project"}{" "}
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </Button>
            </div>
          </fieldset>
        </div>
      </form>
    </div>
  );
}
