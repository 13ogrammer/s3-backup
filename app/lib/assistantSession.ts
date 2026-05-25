import { useEffect, useState } from 'react';

import { bumpAssistantSessionResetVersion } from '@/lib/assistantConfig';
import type { PendingActionPayload } from '@/lib/assistantTools';

export type PendingActionMessage = {
  id: string;
  role: 'pending_action';
  toolCallId: string;
  payload: PendingActionPayload;
  decision: 'awaiting' | 'approved' | 'rejected';
  outcome?: { kind: 'ok'; result: unknown } | { kind: 'error'; error: string };
};

export type ChatMessage =
  | { id: string; role: 'user'; text: string }
  | { id: string; role: 'assistant'; text: string }
  | PendingActionMessage
  | {
      id: string;
      role: 'tool';
      toolCallId: string;
      name: string;
      input: unknown;
      status: 'pending' | 'ok' | 'error';
      result?: unknown;
      errorMessage?: string;
    };

export type SessionState = {
  messages: ChatMessage[];
  turnCount: number;
  inputTokens: number;
  outputTokens: number;
  busy: boolean;
};

export const EMPTY_SESSION: SessionState = {
  messages: [],
  turnCount: 0,
  inputTokens: 0,
  outputTokens: 0,
  busy: false,
};

export type Decision = { kind: 'approved' } | { kind: 'rejected' };

// Module-level singleton — survives tab switches and modal close/reopen.
// Pattern mirrors uploadSession.ts.

let session: SessionState = EMPTY_SESSION;
let draft = '';
let capReached = false;

type SessionListener = (s: SessionState) => void;
type DraftListener = (d: string) => void;
type CapListener = (c: boolean) => void;

const sessionListeners = new Set<SessionListener>();
const draftListeners = new Set<DraftListener>();
const capListeners = new Set<CapListener>();

export function getSession(): SessionState {
  return session;
}

export function setSession(next: SessionState | ((prev: SessionState) => SessionState)): void {
  session = typeof next === 'function' ? next(session) : next;
  for (const l of sessionListeners) l(session);
}

export function subscribeSession(listener: SessionListener): () => void {
  sessionListeners.add(listener);
  return () => sessionListeners.delete(listener);
}

export function useSession(): SessionState {
  const [value, setValue] = useState(session);
  useEffect(() => subscribeSession(setValue), []);
  return value;
}

export function getDraft(): string {
  return draft;
}

export function setDraft(next: string): void {
  draft = next;
  for (const l of draftListeners) l(draft);
}

export function useDraft(): [string, (next: string) => void] {
  const [value, setValue] = useState(draft);
  useEffect(() => {
    draftListeners.add(setValue);
    return () => { draftListeners.delete(setValue); };
  }, []);
  return [value, setDraft];
}

export function getCapReached(): boolean {
  return capReached;
}

export function setCapReached(next: boolean): void {
  capReached = next;
  for (const l of capListeners) l(capReached);
}

export function useCapReached(): boolean {
  const [value, setValue] = useState(capReached);
  useEffect(() => {
    capListeners.add(setValue);
    return () => { capListeners.delete(setValue); };
  }, []);
  return value;
}

// Module refs that survive re-renders and modal close/reopen.
// AbortController and pending resolvers must live here so the runLoop
// can still reach them after the AssistantSheet unmounts and remounts.
export const sessionResetVersionRef = { current: 0 };
export const abortRef: { current: AbortController | null } = { current: null };
export const pendingResolversRef: { current: Map<string, (d: Decision) => void> } = {
  current: new Map(),
};

export function drainPendingResolvers(): void {
  for (const resolve of pendingResolversRef.current.values()) {
    resolve({ kind: 'rejected' });
  }
  pendingResolversRef.current.clear();
}

export async function resetSession(): Promise<void> {
  drainPendingResolvers();
  abortRef.current?.abort();
  setSession(EMPTY_SESSION);
  setCapReached(false);
  setDraft('');
  await bumpAssistantSessionResetVersion();
}
