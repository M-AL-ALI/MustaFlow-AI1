import { useCallback, useLayoutEffect, useRef, useState } from "react";
import {
  claimCreationDraft,
  saveCreationDraft,
  readCreationDraft,
  creationDraftDestination,
  type CreationDraftInput,
} from "@/lib/creation-draft";
import { useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetProjectsSummaryQueryKey,
  getGetRecentActivityQueryKey,
  getListProjectsQueryKey,
  getListTrashedProjectsQueryKey,
  useDeleteProject,
  useGetSecurityBadgeCountsByProject,
  getGetSecurityBadgeCountsByProjectQueryKey,
} from "@workspace/api-client-react";
import { BrainstormPanel } from "@/components/brainstorm-panel";
import { ProjectTrashDialog, type TrashProject } from "@/components/project-trash-dialog";
import { ProjectComposer } from "@/components/projects/project-composer";
import { ProjectDashboard, projectDate } from "@/components/projects/project-dashboard";
import { useClerkUser } from "@/lib/clerk-safe";
import { useToast } from "@/hooks/use-toast";
import { useVoiceInput, useVoiceLang } from "@/hooks/use-voice-input";
import { useWorkspace } from "@/contexts/workspace-context";
import { WorkspaceEntry } from "@/components/workspace-entry";
import { CreateWorkspaceModal } from "@/components/create-workspace-modal";
import { useWorkspaceProjects } from "@/hooks/use-workspace-projects";

type WorkspaceIdea = CreationDraftInput & { id: string | null };

export default function ProjectsPage() {
  const { user, isLoaded, isSignedIn } = useClerkUser();
  const accountId = isLoaded && isSignedIn && user?.id ? user.id : "";
  return <WorkspaceProjectsEntry key={accountId || "loading-account"} accountId={accountId} />;
}

function WorkspaceProjectsEntry({ accountId }: { accountId: string }) {
  const workspace = useWorkspace();
  const [createOpen, setCreateOpen] = useState(false);
  const drafts = useRef(new Map<number, WorkspaceIdea>());
  const [admittedWorkspaceId, setAdmittedWorkspaceId] = useState<number | null>(null);
  const selected = workspace.currentWorkspace;
  const selectedId = selected?.id ?? null;
  const ready =
    Boolean(accountId) &&
    !workspace.isLoading &&
    !workspace.isError &&
    workspace.hasChosenWorkspace &&
    selected !== null;

  useLayoutEffect(() => {
    if (accountId) claimCreationDraft({ accountId, workspaceId: null });
  }, [accountId]);

  useLayoutEffect(() => {
    if (!ready || selectedId === null) {
      setAdmittedWorkspaceId(null);
      return;
    }
    const stored = claimCreationDraft({ accountId, workspaceId: selectedId });
    if (!drafts.current.has(selectedId)) {
      drafts.current.set(
        selectedId,
        stored
          ? {
              id: stored.id,
              prompt: stored.prompt,
              platform: stored.platform,
              intent: stored.intent,
            }
          : { id: null, prompt: "", platform: "web", intent: "build" },
      );
    }
    setAdmittedWorkspaceId(selectedId);
  }, [accountId, ready, selectedId]);

  return (
    <>
      {ready && selected && admittedWorkspaceId === selected.id ? (
        <WorkspaceProjectsHome
          key={accountId + ":" + selected.id}
          accountId={accountId}
          workspaceId={selected.id}
          workspaceName={selected.name}
          initialIdea={drafts.current.get(selected.id)!}
          rememberIdea={(idea, persist = true, expectedId) => {
            const scope = { accountId, workspaceId: selected.id };
            const saved = persist
              ? expectedId === undefined
                ? saveCreationDraft(idea, scope)
                : saveCreationDraft(idea, scope, expectedId)
              : null;
            if (expectedId !== undefined && !saved) {
              // A close callback has no authority to replace a newer receipt.
              const latest = readCreationDraft(scope);
              if (latest) drafts.current.set(selected.id, latest);
              return null;
            }
            drafts.current.set(selected.id, { ...idea, id: saved?.id ?? idea.id });
            return saved?.id ?? null;
          }}
          onChooseWorkspace={workspace.requestWorkspaceChoice}
        />
      ) : (
        <WorkspaceEntry
          workspaces={workspace.workspaces}
          currentWorkspaceId={selected?.id}
          state={
            !accountId || workspace.isLoading || ready
              ? "loading"
              : workspace.isError
                ? "error"
                : "ready"
          }
          onChooseWorkspace={workspace.setCurrentWorkspaceId}
          onCreateWorkspace={() => setCreateOpen(true)}
          onRetry={workspace.retryWorkspaces}
        />
      )}
      <CreateWorkspaceModal open={createOpen} onOpenChange={setCreateOpen} />
    </>
  );
}

function WorkspaceProjectsHome({
  accountId,
  workspaceId,
  workspaceName,
  initialIdea,
  rememberIdea,
  onChooseWorkspace,
}: {
  accountId: string;
  workspaceId: number;
  workspaceName: string;
  initialIdea: WorkspaceIdea;
  rememberIdea: (idea: WorkspaceIdea, persist?: boolean, expectedId?: string) => string | null;
  onChooseWorkspace: () => void;
}) {
  const [, setLocation] = useLocation();
  const { user } = useClerkUser();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { summaryQuery, activityQuery } = useWorkspaceProjects(accountId, workspaceId);
  const { data: securityCounts } = useGetSecurityBadgeCountsByProject({
    query: {
      queryKey: [...getGetSecurityBadgeCountsByProjectQueryKey(), { accountId, workspaceId }],
      enabled: Boolean(accountId),
    },
  });
  const deleteProject = useDeleteProject();
  const [removingId, setRemovingId] = useState<number | null>(null);
  const [trashProject, setTrashProject] = useState<TrashProject | null>(null);
  const [prompt, updatePrompt] = useState(initialIdea.prompt);
  const [platform, updatePlatform] = useState(initialIdea.platform);
  const [showDiscuss, setShowDiscuss] = useState(initialIdea.intent === "brainstorm");
  const currentReceiptId = useRef(initialIdea.id);
  const rememberCurrentIdea = useCallback(
    (idea: WorkspaceIdea) => {
      const savedId = rememberIdea(idea);
      if (savedId) currentReceiptId.current = savedId;
    },
    [rememberIdea],
  );
  const setPrompt = useCallback(
    (value: string) => {
      updatePrompt(value);
      rememberCurrentIdea({
        id: null,
        prompt: value,
        platform,
        intent: showDiscuss ? "brainstorm" : "build",
      });
    },
    [rememberCurrentIdea, platform, showDiscuss],
  );
  const voiceBase = useRef("");
  const voice = useVoiceInput(
    useCallback((text: string) => setPrompt(voiceBase.current + text), [setPrompt]),
  );
  const voiceLanguage = useVoiceLang();

  async function moveToTrash(project: { id: number; name: string }) {
    setRemovingId(project.id);
    try {
      await deleteProject.mutateAsync({ id: project.id });
      toast({
        title: "Project moved to Trash",
        description: '"' + project.name + '" can be restored from Trash for 30 days.',
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: getGetProjectsSummaryQueryKey() }),
        queryClient.invalidateQueries({ queryKey: getGetRecentActivityQueryKey() }),
        queryClient.invalidateQueries({ queryKey: getListProjectsQueryKey() }),
        queryClient.invalidateQueries({ queryKey: getListTrashedProjectsQueryKey() }),
      ]);
    } catch (error) {
      toast({
        title: "Could not move project to Trash",
        description: error instanceof Error ? error.message : "Please try again.",
        variant: "destructive",
      });
      throw error;
    } finally {
      setRemovingId(null);
    }
  }

  return (
    <div className="nf-dashboard">
      <header className="mb-8 flex flex-wrap items-center justify-between gap-3 border-b border-border pb-5">
        <div>
          <p className="nf-eyebrow">Workspace</p>
          <p className="mt-1 text-lg font-semibold">{workspaceName}</p>
        </div>
        <button type="button" className="nf-secondary-button" onClick={onChooseWorkspace}>
          Switch workspace
        </button>
      </header>
      <ProjectComposer
        firstName={user?.firstName ?? user?.fullName?.split(" ")[0]}
        prompt={prompt}
        platform={platform}
        onPlatformChange={(value) => {
          updatePlatform(value);
          rememberCurrentIdea({
            id: null,
            prompt,
            platform: value,
            intent: showDiscuss ? "brainstorm" : "build",
          });
        }}
        onPromptChange={setPrompt}
        onContinue={(text, platform) => {
          const scope = { accountId, workspaceId };
          if (!saveCreationDraft({ intent: "build", prompt: text, platform }, scope)) {
            toast({
              title: "Your idea is still here",
              description: "Browser storage is unavailable. Please try again.",
              variant: "destructive",
            });
            return;
          }
          setLocation(creationDraftDestination(scope));
        }}
        onBrainstorm={() => {
          rememberCurrentIdea({ id: null, prompt, platform, intent: "brainstorm" });
          setShowDiscuss(true);
        }}
        voice={{
          supported: voice.isSupported,
          recording: voice.isRecording,
          language: voiceLanguage,
          toggle: () => {
            if (!voice.isRecording) voiceBase.current = prompt ? prompt.trimEnd() + " " : "";
            voice.toggle();
          },
        }}
      />
      {showDiscuss && (
        <div className="mb-10">
          <BrainstormPanel
            initialInput={prompt}
            onClose={() => {
              const closed: WorkspaceIdea = { id: null, prompt, platform, intent: "build" };
              const expectedId = currentReceiptId.current;
              currentReceiptId.current = expectedId
                ? rememberIdea(closed, true, expectedId)
                : rememberIdea(closed, false);
              setShowDiscuss(false);
            }}
          />
        </div>
      )}
      <ProjectDashboard
        projects={summaryQuery.data?.recent ?? []}
        heading="Projects"
        total={summaryQuery.data?.total ?? 0}
        state={summaryQuery.isLoading ? "loading" : summaryQuery.isError ? "error" : "ready"}
        onRetry={() => {
          void summaryQuery.refetch();
        }}
        retrying={summaryQuery.isFetching}
        onTrash={setTrashProject}
        removingId={removingId}
        securityCounts={securityCounts?.counts}
        snapshotIdentity={user?.id}
      />
      <details className="nf-activity">
        <summary>Recent activity</summary>
        {activityQuery.isLoading ? (
          <p role="status">Loading activity</p>
        ) : activityQuery.isError ? (
          <p role="status">Activity is unavailable right now. Your project list is separate.</p>
        ) : activityQuery.data?.length ? (
          <ol>
            {activityQuery.data.map((item) => (
              <li key={item.id}>
                <p>{item.summary}</p>
                <small>
                  {item.projectName} / {projectDate(item.createdAt)}
                </small>
              </li>
            ))}
          </ol>
        ) : (
          <p className="nf-supporting">Project updates will appear here as you work.</p>
        )}
      </details>
      {trashProject && (
        <ProjectTrashDialog
          project={trashProject}
          onConfirm={moveToTrash}
          onClose={() => setTrashProject(null)}
        />
      )}
    </div>
  );
}
