import {
  documentDirectory,
  getInfoAsync,
  readAsStringAsync,
  writeAsStringAsync,
} from 'expo-file-system/legacy';
import { AppState, type AppStateStatus } from 'react-native';
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { api } from './api';
import type { JobRecord } from './api';

// Persisted job id list lives in documentDirectory so it survives app kills.
const JOBS_FILE = `${documentDirectory ?? ''}s3backup-jobs-v1.json`;

const POLL_INTERVAL_MS = 2000;

type JobsState = {
  /** Live records keyed by jobId */
  records: Map<string, JobRecord>;
  /** Ordered list of job ids still being polled (non-terminal) */
  activeJobIds: string[];
};

export type JobsContextValue = {
  activeJobs: JobRecord[];
  allJobs: JobRecord[];
  addJob: (jobId: string, meta: { fromPrefix: string; toPrefix: string }) => Promise<void>;
  cancelJob: (jobId: string) => Promise<void>;
  dismissJob: (jobId: string) => void;
  retryFailed: (jobId: string) => Promise<string | null>;
};

const JobsContext = createContext<JobsContextValue | null>(null);

export function useJobs(): JobsContextValue {
  const ctx = useContext(JobsContext);
  if (!ctx) throw new Error('useJobs must be used within JobsProvider');
  return ctx;
}

// --- Persistence helpers ---

async function loadPersistedJobIds(): Promise<string[]> {
  try {
    const info = await getInfoAsync(JOBS_FILE);
    if (!info.exists) return [];
    const text = await readAsStringAsync(JOBS_FILE);
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === 'string');
  } catch {
    return [];
  }
}

async function savePersistedJobIds(ids: string[]): Promise<void> {
  try {
    await writeAsStringAsync(JOBS_FILE, JSON.stringify(ids));
  } catch {
    // Best-effort; polling still works from in-memory state.
  }
}

// --- Provider ---

export function JobsProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<JobsState>({ records: new Map(), activeJobIds: [] });
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Returns true for statuses that should stop the polling loop.
  function isTerminal(status: JobRecord['status']): boolean {
    return (
      status === 'completed' ||
      status === 'completed-with-errors' ||
      status === 'cancelled' ||
      status === 'failed'
    );
  }

  // Returns true for statuses where the job should also be evicted from
  // activeJobIds immediately. completed-with-errors is excluded: we keep
  // polling stopped (isTerminal returns true) but leave the row visible in
  // the strip until the user explicitly dismisses it.
  function shouldEvictFromActive(status: JobRecord['status']): boolean {
    return status === 'completed' || status === 'cancelled' || status === 'failed';
  }

  const activeJobs = state.activeJobIds
    .map((id) => state.records.get(id))
    .filter((r): r is JobRecord => r !== undefined);

  const allJobs = Array.from(state.records.values());

  const updateRecord = useCallback((record: JobRecord) => {
    setState((prev) => {
      const records = new Map(prev.records);
      records.set(record.jobId, record);
      const alreadyTracked = prev.activeJobIds.includes(record.jobId);
      const activeJobIds = alreadyTracked
        ? prev.activeJobIds
        : [...prev.activeJobIds, record.jobId];
      return { records, activeJobIds };
    });
  }, []);

  const pollOnce = useCallback(async (jobIds: string[]) => {
    if (jobIds.length === 0) return;
    await Promise.allSettled(
      jobIds.map(async (jobId) => {
        try {
          const record = await api.getMoveJob(jobId);
          setState((prev) => {
            const records = new Map(prev.records);
            records.set(jobId, record);
            // Stop polling terminal jobs, but only evict from activeJobIds
            // if the status is auto-dismissible. completed-with-errors stays
            // in activeJobIds so the strip row remains visible until the
            // user explicitly taps Dismiss.
            const activeJobIds = shouldEvictFromActive(record.status)
              ? prev.activeJobIds.filter((id) => id !== jobId)
              : prev.activeJobIds;
            return { records, activeJobIds };
          });
        } catch (err: unknown) {
          const status = (err as { status?: number }).status;
          if (status === 404) {
            // Job no longer exists on the backend (e.g. bucket wipe).
            setState((prev) => {
              const records = new Map(prev.records);
              const existing = records.get(jobId);
              if (existing) {
                records.set(jobId, {
                  ...existing,
                  status: 'failed',
                  error: 'job not found',
                  updatedAt: new Date().toISOString(),
                });
              }
              const activeJobIds = prev.activeJobIds.filter((id) => id !== jobId);
              return { records, activeJobIds };
            });
          }
          // Other errors (network, etc.) are silent — next tick will retry.
        }
      }),
    );
  }, []);

  function stopPolling() {
    if (pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }
  }

  // Restart polling whenever activeJobIds or pollOnce changes.
  useEffect(() => {
    if (state.activeJobIds.length === 0) {
      stopPolling();
      return;
    }
    // Only poll jobs that aren't yet in a terminal state. completed-with-errors
    // jobs stay in activeJobIds for strip visibility but don't need more polls.
    const pollable = state.activeJobIds.filter((id) => {
      const r = state.records.get(id);
      return !r || !isTerminal(r.status);
    });
    if (pollable.length === 0) {
      stopPolling();
      return;
    }
    stopPolling();
    pollingRef.current = setInterval(() => {
      pollOnce(pollable);
    }, POLL_INTERVAL_MS);
    return stopPolling;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.activeJobIds, state.records, pollOnce]);

  // Pause polling when app goes to background; resume on active.
  useEffect(() => {
    function handleAppState(nextState: AppStateStatus) {
      if (nextState === 'active') {
        const pollable = state.activeJobIds.filter((id) => {
          const r = state.records.get(id);
          return !r || !isTerminal(r.status);
        });
        if (pollable.length > 0 && !pollingRef.current) {
          pollingRef.current = setInterval(() => {
            pollOnce(pollable);
          }, POLL_INTERVAL_MS);
        }
      } else {
        stopPolling();
      }
    }
    const sub = AppState.addEventListener('change', handleAppState);
    return () => sub.remove();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.activeJobIds, state.records, pollOnce]);

  // On mount: restore persisted job ids and poll them immediately.
  useEffect(() => {
    (async () => {
      const ids = await loadPersistedJobIds();
      if (ids.length === 0) return;
      setState((prev) => ({
        ...prev,
        activeJobIds: [...new Set([...prev.activeJobIds, ...ids])],
      }));
      await pollOnce(ids);
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist activeJobIds whenever they change.
  useEffect(() => {
    savePersistedJobIds(state.activeJobIds);
  }, [state.activeJobIds]);

  const addJob = useCallback(
    async (jobId: string, meta: { fromPrefix: string; toPrefix: string }) => {
      const now = new Date().toISOString();
      const optimistic: JobRecord = {
        jobId,
        kind: 'folder-move',
        fromPrefix: meta.fromPrefix,
        toPrefix: meta.toPrefix,
        status: 'queued',
        total: 0,
        moved: 0,
        failed: [],
        startedAt: now,
        updatedAt: now,
      };
      updateRecord(optimistic);
      // Immediately fetch the real record from the backend.
      try {
        const real = await api.getMoveJob(jobId);
        updateRecord(real);
      } catch {
        // Keep optimistic; polling will reconcile.
      }
    },
    [updateRecord],
  );

  const cancelJob = useCallback(async (jobId: string) => {
    try {
      await api.cancelMoveJob(jobId);
      setState((prev) => {
        const records = new Map(prev.records);
        const existing = records.get(jobId);
        if (existing) {
          records.set(jobId, {
            ...existing,
            cancelRequested: true,
            updatedAt: new Date().toISOString(),
          });
        }
        return { ...prev, records };
      });
    } catch {
      // Silently ignore; polling will reflect actual state.
    }
  }, []);

  const dismissJob = useCallback((jobId: string) => {
    setState((prev) => {
      const records = new Map(prev.records);
      records.delete(jobId);
      const activeJobIds = prev.activeJobIds.filter((id) => id !== jobId);
      return { records, activeJobIds };
    });
  }, []);

  const retryFailed = useCallback(
    async (jobId: string): Promise<string | null> => {
      const record = state.records.get(jobId);
      if (!record || record.failed.length === 0) return null;
      const keys = record.failed.map((f) => f.key);
      const res = await api.retryFailedMove(jobId, record.fromPrefix, record.toPrefix, keys);
      await addJob(res.jobId, { fromPrefix: record.fromPrefix, toPrefix: record.toPrefix });
      dismissJob(jobId);
      return res.jobId;
    },
    [state.records, addJob, dismissJob],
  );

  const value: JobsContextValue = {
    activeJobs,
    allJobs,
    addJob,
    cancelJob,
    dismissJob,
    retryFailed,
  };

  return (
    <JobsContext.Provider value={value}>
      {children}
    </JobsContext.Provider>
  );
}
