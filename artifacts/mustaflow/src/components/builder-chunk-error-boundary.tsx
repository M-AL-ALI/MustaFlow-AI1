import { Component, type ReactNode } from "react";
import {
  BUILDER_CHUNK_REFRESHING_MESSAGE,
  BuilderChunkRecoveryError,
  BuilderChunkReloadPendingError,
  chunkAssetUrlFromError,
  clearBuilderChunkReloadGuard,
  isBuilderChunkLoadFailure,
  readBuilderChunkFailure,
} from "@/lib/builder-chunk-recovery";

type Props = {
  children: ReactNode;
  pathname?: string;
  storage?: Pick<Storage, "getItem" | "removeItem">;
  reload?: () => void;
};

type State = {
  error: unknown | null;
};

export class BuilderChunkErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error };
  }

  private pathname(): string {
    return this.props.pathname ?? window.location.pathname;
  }

  private reload = (): void => {
    const storage = this.props.storage ?? window.sessionStorage;
    clearBuilderChunkReloadGuard(this.pathname(), storage);
    (this.props.reload ?? (() => window.location.reload()))();
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    if (error instanceof BuilderChunkReloadPendingError) {
      return (
        <main
          className="grid min-h-dvh place-items-center bg-background px-6 text-foreground"
          data-testid="builder-chunk-refreshing"
        >
          <p className="text-sm font-medium text-muted-foreground" role="status" aria-live="polite">
            {BUILDER_CHUNK_REFRESHING_MESSAGE}
          </p>
        </main>
      );
    }

    const isChunkFailure =
      error instanceof BuilderChunkRecoveryError ||
      isBuilderChunkLoadFailure({
        pathname: this.pathname(),
        error,
        assetUrl: chunkAssetUrlFromError(error),
      });
    if (!isChunkFailure) throw error;
    const storage = this.props.storage ?? window.sessionStorage;
    const diagnostic = readBuilderChunkFailure(storage, this.pathname());

    return (
      <main
        className="grid min-h-dvh place-items-center bg-background px-6 text-foreground"
        data-testid="builder-chunk-fallback"
      >
        <section className="max-w-md text-center">
          <h1 className="text-base font-semibold">
            NabuFlow couldn’t finish loading this workspace.
          </h1>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            The app may have been updated while this page was open. Reload to reconnect to the
            latest version.
          </p>
          {diagnostic && (
            <details
              className="mt-4 rounded-md border border-border/70 bg-muted/40 px-3 py-2 text-left text-xs text-muted-foreground"
              data-testid="builder-chunk-diagnostic"
            >
              <summary className="cursor-pointer font-medium text-foreground">
                Technical details
              </summary>
              <dl className="mt-2 grid grid-cols-[auto,1fr] gap-x-2 gap-y-1 break-all">
                <dt>Class</dt>
                <dd>{diagnostic.errorClass}</dd>
                <dt>Message</dt>
                <dd>{diagnostic.message || "No message supplied"}</dd>
                <dt>Asset</dt>
                <dd>{diagnostic.assetPath ?? "Unknown"}</dd>
                <dt>Transport</dt>
                <dd>
                  {diagnostic.assetProbe.outcome === "response"
                    ? `HTTP ${diagnostic.assetProbe.status} ${diagnostic.assetProbe.mediaType}`
                    : diagnostic.assetProbe.outcome === "transport-error"
                      ? diagnostic.assetProbe.errorClass
                      : "Unavailable"}
                </dd>
              </dl>
            </details>
          )}
          <button
            type="button"
            onClick={this.reload}
            className="mt-5 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            Reload
          </button>
        </section>
      </main>
    );
  }
}
