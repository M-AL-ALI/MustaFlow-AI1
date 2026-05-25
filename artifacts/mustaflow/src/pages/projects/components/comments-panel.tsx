import { useState, useEffect, useCallback } from "react";
import {
  MessageSquare,
  Check,
  CheckCheck,
  Loader2,
  ChevronDown,
  ChevronRight,
  Send,
  Pencil,
  Trash2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { useClerkUser } from "@/lib/clerk-safe";

interface Comment {
  id: number;
  projectId: number;
  authorId: string;
  authorName: string | null;
  parentId: number | null;
  filePath: string | null;
  lineStart: number | null;
  body: string;
  resolved: boolean;
  editedAt: string | null;
  createdAt: string;
  replies: Comment[];
}

interface CommentsPanelProps {
  projectId: number;
  filePath?: string;
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function CommentThread({
  comment,
  projectId,
  currentUserId,
  onRefresh,
}: {
  comment: Comment;
  projectId: number;
  currentUserId: string | undefined;
  onRefresh: () => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const [replying, setReplying] = useState(false);
  const [replyBody, setReplyBody] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editBody, setEditBody] = useState(comment.body);

  const submitReply = async () => {
    if (!replyBody.trim()) return;
    setSubmitting(true);
    try {
      await fetch(`/api/projects/${projectId}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: replyBody.trim(), parentId: comment.id }),
      });
      setReplyBody("");
      setReplying(false);
      onRefresh();
    } finally {
      setSubmitting(false);
    }
  };

  const saveEdit = async () => {
    if (!editBody.trim()) return;
    await fetch(`/api/projects/${projectId}/comments/${comment.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: editBody.trim() }),
    });
    setEditing(false);
    onRefresh();
  };

  const toggleResolve = async () => {
    await fetch(`/api/projects/${projectId}/comments/${comment.id}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resolved: !comment.resolved }),
    });
    onRefresh();
  };

  const deleteComment = async () => {
    await fetch(`/api/projects/${projectId}/comments/${comment.id}`, { method: "DELETE" });
    onRefresh();
  };

  return (
    <div
      className={cn(
        "rounded-lg border p-3 space-y-2",
        comment.resolved ? "border-border/40 bg-muted/20" : "border-border bg-card",
      )}
    >
      {/* Header */}
      <div className="flex items-start gap-2">
        <div className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-primary/10 text-[10px] font-bold text-primary">
          {(comment.authorName ?? "?").charAt(0).toUpperCase()}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="text-xs font-semibold">{comment.authorName ?? "Unknown"}</span>
            {comment.filePath && (
              <span className="text-[10px] text-muted-foreground truncate max-w-[120px]">
                {comment.filePath}
                {comment.lineStart != null ? `:${comment.lineStart}` : ""}
              </span>
            )}
            <span className="ml-auto text-[10px] text-muted-foreground">
              {timeAgo(comment.createdAt)}
            </span>
          </div>
          {comment.resolved && (
            <span className="inline-flex items-center gap-1 text-[10px] text-emerald-600">
              <CheckCheck className="h-2.5 w-2.5" /> Resolved
            </span>
          )}
        </div>
      </div>

      {/* Body */}
      {editing ? (
        <div className="space-y-1.5">
          <Textarea
            value={editBody}
            onChange={(e) => setEditBody(e.target.value)}
            className="text-sm min-h-[60px]"
            autoFocus
          />
          <div className="flex gap-1.5">
            <Button size="sm" className="h-6 text-xs" onClick={() => void saveEdit()}>
              Save
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-6 text-xs"
              onClick={() => setEditing(false)}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <p
          className={cn("text-sm whitespace-pre-wrap", comment.resolved && "text-muted-foreground")}
        >
          {comment.body}
          {comment.editedAt && (
            <span className="ml-1 text-[10px] text-muted-foreground">(edited)</span>
          )}
        </p>
      )}

      {/* Actions */}
      <div className="flex items-center gap-1">
        <button
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={() => setReplying((r) => !r)}
        >
          <MessageSquare className="h-3 w-3" /> Reply
        </button>
        <button
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={() => void toggleResolve()}
        >
          <Check className="h-3 w-3" /> {comment.resolved ? "Unresolve" : "Resolve"}
        </button>
        {currentUserId === comment.authorId && (
          <>
            <button
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={() => {
                setEditing(true);
                setEditBody(comment.body);
              }}
            >
              <Pencil className="h-3 w-3" /> Edit
            </button>
            <button
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-red-500/10 hover:text-red-500"
              onClick={() => void deleteComment()}
            >
              <Trash2 className="h-3 w-3" /> Delete
            </button>
          </>
        )}
        {comment.replies.length > 0 && (
          <button
            className="ml-auto flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted"
            onClick={() => setExpanded((e) => !e)}
          >
            {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            {comment.replies.length} {comment.replies.length === 1 ? "reply" : "replies"}
          </button>
        )}
      </div>

      {/* Replies */}
      {expanded && comment.replies.length > 0 && (
        <div className="ml-4 space-y-2 border-l border-border/50 pl-3">
          {comment.replies.map((reply) => (
            <div key={reply.id} className="space-y-1">
              <div className="flex items-center gap-1.5">
                <div className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-muted text-[9px] font-bold">
                  {(reply.authorName ?? "?").charAt(0).toUpperCase()}
                </div>
                <span className="text-xs font-semibold">{reply.authorName ?? "Unknown"}</span>
                <span className="text-[10px] text-muted-foreground">
                  {timeAgo(reply.createdAt)}
                </span>
              </div>
              <p className="text-sm pl-6.5 whitespace-pre-wrap">{reply.body}</p>
            </div>
          ))}
        </div>
      )}

      {/* Reply composer */}
      {replying && (
        <div className="flex items-end gap-2 pt-1">
          <Textarea
            value={replyBody}
            onChange={(e) => setReplyBody(e.target.value)}
            placeholder="Write a reply…"
            className="text-sm min-h-[48px] flex-1 resize-none"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void submitReply();
            }}
          />
          <div className="flex flex-col gap-1">
            <Button
              size="icon"
              className="h-8 w-8"
              onClick={() => void submitReply()}
              disabled={submitting || !replyBody.trim()}
            >
              {submitting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Send className="h-3.5 w-3.5" />
              )}
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className="h-8 w-8"
              onClick={() => setReplying(false)}
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

export function CommentsPanel({ projectId, filePath }: CommentsPanelProps) {
  const { user } = useClerkUser();
  const [comments, setComments] = useState<Comment[]>([]);
  const [loading, setLoading] = useState(false);
  const [newBody, setNewBody] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [showResolved, setShowResolved] = useState(false);

  const fetchComments = useCallback(async () => {
    setLoading(true);
    try {
      const url = filePath
        ? `/api/projects/${projectId}/comments?filePath=${encodeURIComponent(filePath)}`
        : `/api/projects/${projectId}/comments`;
      const r = await fetch(url);
      if (r.ok) setComments((await r.json()) as Comment[]);
    } finally {
      setLoading(false);
    }
  }, [projectId, filePath]);

  useEffect(() => {
    void fetchComments();
  }, [fetchComments]);

  const submitComment = async () => {
    if (!newBody.trim()) return;
    setSubmitting(true);
    try {
      await fetch(`/api/projects/${projectId}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          body: newBody.trim(),
          filePath: filePath ?? null,
          authorName: user?.fullName ?? user?.username ?? null,
          authorAvatar: user?.imageUrl ?? null,
        }),
      });
      setNewBody("");
      void fetchComments();
    } finally {
      setSubmitting(false);
    }
  };

  const visible = showResolved ? comments : comments.filter((c) => !c.resolved);
  const resolvedCount = comments.filter((c) => c.resolved).length;

  return (
    <div className="flex flex-col h-full">
      {/* New comment composer */}
      <div className="border-b border-border p-3 space-y-2">
        <Textarea
          value={newBody}
          onChange={(e) => setNewBody(e.target.value)}
          placeholder="Leave a comment… (Cmd+Enter to submit)"
          className="text-sm min-h-[72px] resize-none"
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void submitComment();
          }}
        />
        <div className="flex items-center justify-between">
          <span className="text-[11px] text-muted-foreground">Cmd+Enter to submit</span>
          <Button
            size="sm"
            className="h-7 text-xs gap-1.5"
            onClick={() => void submitComment()}
            disabled={submitting || !newBody.trim()}
          >
            {submitting ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Send className="h-3 w-3" />
            )}
            Comment
          </Button>
        </div>
      </div>

      {/* Filter bar */}
      {resolvedCount > 0 && (
        <div className="px-3 py-2 border-b border-border">
          <button
            className="text-[11px] text-muted-foreground hover:text-foreground flex items-center gap-1"
            onClick={() => setShowResolved((s) => !s)}
          >
            <CheckCheck className="h-3 w-3" />
            {showResolved ? "Hide" : "Show"} {resolvedCount} resolved
          </button>
        </div>
      )}

      {/* Comment list */}
      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {loading && comments.length === 0 && (
          <div className="flex items-center justify-center py-8 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
          </div>
        )}
        {!loading && visible.length === 0 && (
          <div className="flex flex-col items-center justify-center py-12 text-center space-y-2">
            <MessageSquare className="h-8 w-8 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">No comments yet</p>
            <p className="text-xs text-muted-foreground">Start the conversation above</p>
          </div>
        )}
        {visible.map((c) => (
          <CommentThread
            key={c.id}
            comment={c}
            projectId={projectId}
            currentUserId={user?.id}
            onRefresh={() => void fetchComments()}
          />
        ))}
      </div>
    </div>
  );
}
