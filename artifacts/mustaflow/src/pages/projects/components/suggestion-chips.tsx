import { useEffect, useState } from "react";
import {
  getListSuggestionsQueryKey,
  type ProjectSuggestion,
  useAcceptSuggestion,
  useDismissSuggestion,
  useListSuggestions,
  useSaveSuggestion,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { InlineIdeas } from "./inline-ideas";

interface SuggestionChipsProps {
  projectId: number;
  taskId: number;
  onAccepted?: (taskId: number) => void;
}

export function SuggestionChips({ projectId, taskId, onAccepted }: SuggestionChipsProps) {
  const queryClient = useQueryClient();
  const [generationTimedOut, setGenerationTimedOut] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setGenerationTimedOut(true), 45_000);
    return () => clearTimeout(timer);
  }, []);

  const { data: suggestions } = useListSuggestions(
    projectId,
    { taskId },
    {
      query: {
        queryKey: getListSuggestionsQueryKey(projectId, { taskId }),
        refetchInterval: (query) => {
          const data = query.state.data;
          return !data || data.length === 0 ? 4_000 : false;
        },
        refetchIntervalInBackground: false,
        staleTime: 30_000,
      },
    },
  );

  const refreshIdeas = () =>
    queryClient.invalidateQueries({
      // Prefix invalidation refreshes both the task-scoped inline list and Ideas tab.
      queryKey: getListSuggestionsQueryKey(projectId),
    });

  const accept = useAcceptSuggestion({
    mutation: {
      onSuccess: (data) => {
        void refreshIdeas();
        if (data.taskId && onAccepted) onAccepted(data.taskId);
      },
    },
  });
  const save = useSaveSuggestion({
    mutation: {
      onSuccess: () => {
        void refreshIdeas();
      },
    },
  });
  const dismiss = useDismissSuggestion({
    mutation: {
      onSuccess: () => {
        void refreshIdeas();
      },
    },
  });

  const visible = (suggestions ?? []).filter(
    (suggestion: ProjectSuggestion) =>
      suggestion.status !== "dismissed" && suggestion.status !== "accepted",
  );

  return (
    <InlineIdeas
      ideas={visible}
      loading={!generationTimedOut && visible.length === 0}
      buildPending={accept.isPending}
      onBuild={(suggestion, promptOverride) => {
        const override = promptOverride?.trim();
        accept.mutate({
          id: projectId,
          suggestionId: suggestion.id,
          ...(override && override !== suggestion.prompt
            ? { data: { promptOverride: override } }
            : {}),
        });
      }}
      onSave={(suggestion) =>
        save.mutate({ id: projectId, suggestionId: suggestion.id })
      }
      onDismiss={(suggestion) =>
        dismiss.mutate({ id: projectId, suggestionId: suggestion.id })
      }
      className="mt-2.5"
    />
  );
}
