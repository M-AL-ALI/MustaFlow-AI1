import { Component, type ReactNode } from "react";
import {
  BUILDER_CHUNK_REFRESHING_MESSAGE,
  BuilderChunkRecoveryError,
  BuilderChunkReloadPendingError,
  chunkAssetUrlFromError,
  clearBuilderChunkReloadGuard,
  isBuilderChunkLoadFailure,
} from "@/lib/builder-chunk-recovery";

type Props = {
  children: ReactNode;
  pathname?: string;
  storage?: Pick<Storage, "removeItem">;
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

    return (
      <main
        className="grid min-h-dvh place-items-center bg-background px-6 text-foreground"
        data-testid="builder-chunk-fallback"
      >
        <section className="max-w-md text-center">
          <h1 className="text-base font-semibold">NabuFlow couldn’t finish loading this workspace.</h1>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            The app may have been updated while this page was open. Reload to reconnect to the
            latest version.
          </p>
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
