import { useEffect, useState } from 'react';

// Module-level singleton tracking whether an upload session is active.
// Using a module singleton rather than React context lets non-component
// code (activity screen's bulk actions) read and write the flag without
// threading a context provider through the tree.

let active = false;
type Listener = (active: boolean) => void;
const listeners = new Set<Listener>();

export function setUploadSessionActive(value: boolean): void {
  if (active === value) return;
  active = value;
  for (const l of listeners) l(value);
}

export function isUploadSessionActive(): boolean {
  return active;
}

export function subscribeUploadSession(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useUploadSessionActive(): boolean {
  const [value, setValue] = useState(active);
  useEffect(() => subscribeUploadSession(setValue), []);
  return value;
}
