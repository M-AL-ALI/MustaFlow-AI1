/**
 * In-memory stream session store for SSE resume support.
 *
 * When a converse stream starts the server creates a session, buffers every
 * emitted token, and exposes the buffer to the resume endpoint so a
 * reconnecting client can pick up from where it left off without restarting
 * the whole AI pipeline.
 *
 * Sessions are evicted after SESSION_TTL_MS to bound memory usage.
 */
import { EventEmitter } from "events";
import { randomUUID } from "crypto";

export interface StreamSession {
  tokens: string[];
  complete: boolean;
  donePayload?: Record<string, unknown>;
  errorPayload?: { message: string; userMessageId?: number; assistantMessageId?: number };
  emitter: EventEmitter;
  createdAt: number;
}

const sessions = new Map<string, StreamSession>();
const SESSION_TTL_MS = 10 * 60 * 1_000;

setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.createdAt > SESSION_TTL_MS) {
      session.emitter.removeAllListeners();
      sessions.delete(id);
    }
  }
}, 60_000).unref();

export function createStreamSession(): { sessionId: string; session: StreamSession } {
  const sessionId = randomUUID();
  const session: StreamSession = {
    tokens: [],
    complete: false,
    emitter: new EventEmitter(),
    createdAt: Date.now(),
  };
  session.emitter.setMaxListeners(20);
  sessions.set(sessionId, session);
  return { sessionId, session };
}

export function getStreamSession(sessionId: string): StreamSession | undefined {
  return sessions.get(sessionId);
}

export function deleteStreamSession(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (session) {
    session.emitter.removeAllListeners();
    sessions.delete(sessionId);
  }
}
