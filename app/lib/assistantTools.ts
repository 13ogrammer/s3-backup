import * as MediaLibrary from 'expo-media-library';

import { api } from './api';
import type { JobRecord } from './api';
import type { LLMToolDefinition } from './llm';
import { loadActivity, type ActivityUploadEntry, type ActivityMoveEntry, type ActivityAutoBackupRunEntry } from './activityLog';
import { loadBackedUpMap } from './backedUpState';
import { loadAutoBackupState } from './autoBackupState';
import { loadPendingUploads } from './uploadState';
import type { ActiveUploadSnapshot } from './upload';

export type ToolExecutor = (input: unknown) => Promise<unknown>;

export type AssistantTool = {
  definition: LLMToolDefinition;
  execute: ToolExecutor;
};

// ---------------------------------------------------------------------------
// Pending-action sentinel — write tools return this instead of calling the
// backend directly. The runLoop in assistant.tsx intercepts it, renders a
// ConfirmationCard, and only executes the real action after user approval.
// ---------------------------------------------------------------------------

export const PENDING_ACTION_SENTINEL = '__assistant_pending_action__' as const;

export type PendingActionKind = 'create_folder' | 'move';

export type PendingActionPayload =
  | {
      sentinel: typeof PENDING_ACTION_SENTINEL;
      kind: 'create_folder';
      summary: string;
      args: { prefix: string };
    }
  | {
      sentinel: typeof PENDING_ACTION_SENTINEL;
      kind: 'move';
      summary: string;
      args:
        | { kind: 'file'; from: string; to: string }
        | { kind: 'folder'; fromPrefix: string; toPrefix: string };
    };

export function isPendingAction(v: unknown): v is PendingActionPayload {
  return (
    v !== null &&
    typeof v === 'object' &&
    (v as { sentinel?: unknown }).sentinel === PENDING_ACTION_SENTINEL
  );
}

function safeInput<T>(input: unknown): T {
  return (input ?? {}) as T;
}

const listObjectsTool: AssistantTool = {
  definition: {
    type: 'function',
    function: {
      name: 'list_objects',
      description:
        "List files and folders at an S3 prefix. Returns the same shape as the Backup tab's folder view. Pass `recursive: true` only when needed — large recursive lists can return hundreds of entries. For aggregate questions (total counts, sizes), prefer `get_folder_preview` or `get_storage_stats` instead.",
      parameters: {
        type: 'object',
        properties: {
          prefix: { type: 'string', description: 'S3 prefix to list. Omit for root.' },
          recursive: { type: 'boolean', description: 'If true, list all objects recursively.' },
        },
      },
    },
  },
  execute: async (input) => {
    try {
      const { prefix, recursive } = safeInput<{ prefix?: string; recursive?: boolean }>(input);
      return await api.list({ prefix: prefix ?? '', recursive });
    } catch (err) {
      return { error: err instanceof Error ? err.message : 'list_objects failed' };
    }
  },
};

const getObjectMetadataTool: AssistantTool = {
  definition: {
    type: 'function',
    function: {
      name: 'get_object_metadata',
      description:
        'Returns size, last-modified, and EXIF metadata (createdAt, dimensions, camera make/model/lens, ISO, GPS) for a single object. 5-second timeout per call. Do NOT call this in a loop over many keys — for aggregate questions use `get_storage_stats` or `get_folder_preview` instead.',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'The full S3 object key.' },
        },
        required: ['key'],
      },
    },
  },
  execute: async (input) => {
    try {
      const { key } = safeInput<{ key: string }>(input);
      return await api.head(key);
    } catch (err) {
      return { error: err instanceof Error ? err.message : 'get_object_metadata failed' };
    }
  },
};

const getFolderPreviewTool: AssistantTool = {
  definition: {
    type: 'function',
    function: {
      name: 'get_folder_preview',
      description:
        "Returns recursive file and folder counts plus a few sample thumbnails for an S3 prefix. Use this for 'how many photos in X' style questions. Pass an empty string for the bucket root.",
      parameters: {
        type: 'object',
        properties: {
          prefix: {
            type: 'string',
            description: "S3 prefix (folder path). Empty string ('') means the bucket root.",
          },
        },
      },
    },
  },
  execute: async (input) => {
    try {
      const { prefix } = safeInput<{ prefix?: string }>(input);
      return await api.folderPreview(prefix ?? '');
    } catch (err) {
      return { error: err instanceof Error ? err.message : 'get_folder_preview failed' };
    }
  },
};

const getStorageStatsTool: AssistantTool = {
  definition: {
    type: 'function',
    function: {
      name: 'get_storage_stats',
      description:
        "Returns precomputed storage statistics for the whole bucket: total bytes/count, breakdown by type, top folders by size, files larger than 200MB (`largeFiles`) and 1GB (`veryLargeFiles`), and growth over time. Server-side cached. Use this for 'largest folder', 'largest files', 'how much storage', and total-count questions.",
      parameters: {
        type: 'object',
        properties: {
          refresh: { type: 'boolean', description: 'If true, bypass server cache and recompute.' },
        },
      },
    },
  },
  execute: async (input) => {
    try {
      const { refresh } = safeInput<{ refresh?: boolean }>(input);
      return await api.stats({ refresh });
    } catch (err) {
      return { error: err instanceof Error ? err.message : 'get_storage_stats failed' };
    }
  },
};

const existsTool: AssistantTool = {
  definition: {
    type: 'function',
    function: {
      name: 'exists',
      description:
        'Check which of a list of keys currently exist. Read-only sanity check; returns the subset that exist.',
      parameters: {
        type: 'object',
        properties: {
          keys: {
            type: 'array',
            items: { type: 'string' },
            description: 'List of S3 object keys to check.',
          },
        },
        required: ['keys'],
      },
    },
  },
  execute: async (input) => {
    try {
      const { keys } = safeInput<{ keys: string[] }>(input);
      return await api.exists(keys);
    } catch (err) {
      return { error: err instanceof Error ? err.message : 'exists failed' };
    }
  },
};

const createFolderTool: AssistantTool = {
  definition: {
    type: 'function',
    function: {
      name: 'create_folder',
      description:
        'Create a new empty folder at the given S3 prefix. Prefix MUST end with "/". Idempotent: creating an existing folder is a no-op. Requires user approval before running.',
      parameters: {
        type: 'object',
        properties: {
          prefix: {
            type: 'string',
            description: 'Folder prefix ending in "/", e.g. "photos/2025/".',
          },
        },
        required: ['prefix'],
      },
    },
  },
  execute: async (input) => {
    const { prefix } = safeInput<{ prefix: string }>(input);
    const summary = `Create folder "${prefix}"`;
    const payload: PendingActionPayload = {
      sentinel: PENDING_ACTION_SENTINEL,
      kind: 'create_folder',
      summary,
      args: { prefix },
    };
    return payload;
  },
};

const moveTool: AssistantTool = {
  definition: {
    type: 'function',
    function: {
      name: 'move',
      description:
        'Move a file or a folder to a new location. For files, use kind="file" with `from`/`to` keys. For folders, use kind="folder" with `from`/`to` prefixes ending in "/". Folder moves are async and return a jobId; the user will see it under the Backup tab. Requires user approval before running.',
      parameters: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['file', 'folder'] },
          from: { type: 'string' },
          to: { type: 'string' },
        },
        required: ['kind', 'from', 'to'],
      },
    },
  },
  execute: async (input) => {
    const { kind, from, to } = safeInput<{ kind: 'file' | 'folder'; from: string; to: string }>(input);
    if (kind === 'file') {
      const summary = `Move file "${from}" → "${to}"`;
      const payload: PendingActionPayload = {
        sentinel: PENDING_ACTION_SENTINEL,
        kind: 'move',
        summary,
        args: { kind: 'file', from, to },
      };
      return payload;
    } else {
      const summary = `Move folder "${from}" → "${to}"`;
      const payload: PendingActionPayload = {
        sentinel: PENDING_ACTION_SENTINEL,
        kind: 'move',
        summary,
        // Normalise to the backend's fromPrefix/toPrefix naming.
        args: { kind: 'folder', fromPrefix: from, toPrefix: to },
      };
      return payload;
    }
  },
};

// ---------------------------------------------------------------------------
// Local-state read-only tools
// These wrap in-memory/file state that is invisible to the bucket-scoped tools.
// None of them use PENDING_ACTION_SENTINEL (all are read-only).
// ---------------------------------------------------------------------------

// get_recent_activity returns entries without localUri to avoid leaking
// internal device paths into the LLM context.
type RedactedUploadEntry = Omit<ActivityUploadEntry, 'localUri'>;
type RedactedActivityEntry = RedactedUploadEntry | ActivityMoveEntry | ActivityAutoBackupRunEntry;

const getRecentActivityTool: AssistantTool = {
  definition: {
    type: 'function',
    function: {
      name: 'get_recent_activity',
      description:
        'Returns recent activity from the local activity log (the same source as the Activity tab). Includes successful uploads, successful moves, auto-backup runs, and failures. Local file paths are redacted. Returns [] if the log is empty.',
      parameters: {
        type: 'object',
        properties: {
          limit: {
            type: 'number',
            description: 'Max entries to return (default 20, max 100).',
          },
          since: {
            type: 'string',
            description: 'ISO 8601 timestamp. Only entries with lastAt >= this value are returned.',
          },
        },
      },
    },
  },
  execute: async (input) => {
    try {
      const { limit: rawLimit, since } = safeInput<{ limit?: number; since?: string }>(input);
      const limit = Math.min(Math.max(1, rawLimit ?? 20), 100);
      const sinceMs = since ? Date.parse(since) : null;

      const all = await loadActivity();

      let entries: RedactedActivityEntry[] = all.map((e) => {
        if (e.kind === 'upload') {
          // Strip localUri to avoid leaking internal device paths into LLM context.
          const { localUri: _dropped, ...rest } = e;
          return rest as RedactedUploadEntry;
        }
        return e as ActivityMoveEntry | ActivityAutoBackupRunEntry;
      });

      if (sinceMs !== null && !isNaN(sinceMs)) {
        entries = entries.filter((e) => e.lastAt >= sinceMs);
      }

      const sliced = entries.slice(0, limit);
      return { entries: sliced, total: entries.length };
    } catch (err) {
      return { error: err instanceof Error ? err.message : 'get_recent_activity failed' };
    }
  },
};

const getBackupStatusTool: AssistantTool = {
  definition: {
    type: 'function',
    function: {
      name: 'get_backup_status',
      description:
        'Returns local backup status: device asset count, how many have been backed up, and auto-backup config + last-run info. Pure local state — does not call the S3 backend. Note: backedUpCount may overstate reality — deleted device assets are not pruned from the local map.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
  execute: async (_input) => {
    try {
      const perm = await MediaLibrary.getPermissionsAsync();
      if (!perm.granted) {
        return { error: 'media_permission_not_granted' };
      }

      const [{ totalCount }, backedUpMap, autoState] = await Promise.all([
        // first:1 is enough to read totalCount without paginating
        MediaLibrary.getAssetsAsync({ first: 1 }),
        loadBackedUpMap(),
        loadAutoBackupState(),
      ]);

      const deviceAssetCount = totalCount;
      const backedUpCount = Object.keys(backedUpMap).length;
      const notBackedUpCount = Math.max(0, deviceAssetCount - backedUpCount);

      const { lastRanAt, failureCount } = autoState;
      let lastRunOutcome: 'success' | 'failure' | 'unknown';
      if (lastRanAt === null) {
        lastRunOutcome = 'unknown';
      } else if (failureCount > 0) {
        lastRunOutcome = 'failure';
      } else {
        lastRunOutcome = 'success';
      }

      return {
        deviceAssetCount,
        backedUpCount,
        notBackedUpCount,
        autoBackup: {
          enabled: autoState.enabled,
          mode: autoState.backupMode,
          prefix: autoState.prefix,
          lastRanAt,
          lastRunOutcome,
          failureCount,
        },
        caveat: 'backedUpCount may overstate reality — deleted device assets are not pruned from the local map.',
      };
    } catch (err) {
      return { error: err instanceof Error ? err.message : 'get_backup_status failed' };
    }
  },
};

// get_active_jobs is built via factory so it can receive the in-memory jobs
// snapshot from the React context without needing to re-read persisted JSON.
// getActiveUploadsSnapshot provides live simple-upload progress from the
// module-level Map in upload.ts, overlaid on the persisted pending state.
function buildGetActiveJobsTool(
  getJobsSnapshot: () => JobRecord[],
  getActiveUploadsSnapshot: () => ReadonlyMap<string, ActiveUploadSnapshot>,
): AssistantTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'get_active_jobs',
        description:
          "Returns currently in-flight uploads (pending or paused) and active folder-move jobs with progress fractions. Use for 'what's running right now?' style questions.",
        parameters: {
          type: 'object',
          properties: {},
        },
      },
    },
    execute: async (_input) => {
      try {
        const [pendingUploads, jobRecords] = await Promise.all([
          loadPendingUploads(),
          Promise.resolve(getJobsSnapshot()),
        ]);

        const snapshot = getActiveUploadsSnapshot();

        const uploads = pendingUploads.map((u) => {
          let uploadedBytes: number;
          let updatedAt: number = u.updatedAt;

          if (u.kind === 'multipart') {
            uploadedBytes = u.completedParts.length * u.partSize;
          } else {
            // Overlay live in-memory progress for simple uploads; fall back to
            // 0 if the first onProgress tick hasn't fired yet.
            const snap = snapshot.get(u.remoteKey);
            if (snap) {
              uploadedBytes = Math.min(snap.uploadedBytes, u.totalBytes);
              updatedAt = Math.max(snap.updatedAt, u.updatedAt);
            } else {
              uploadedBytes = 0;
            }
          }

          const progress = u.totalBytes > 0 ? uploadedBytes / u.totalBytes : 0;
          return {
            remoteKey: u.remoteKey,
            kind: u.kind,
            contentType: u.contentType,
            totalBytes: u.totalBytes,
            uploadedBytes,
            progress,
            updatedAt,
          };
        });

        const moveJobs = jobRecords.map((r) => ({
          jobId: r.jobId,
          fromPrefix: r.fromPrefix,
          toPrefix: r.toPrefix,
          status: r.status,
          total: r.total,
          moved: r.moved,
          progress: r.total > 0 ? r.moved / r.total : 0,
          failedCount: r.failed.length,
        }));

        return { uploads, moveJobs };
      } catch (err) {
        return { error: err instanceof Error ? err.message : 'get_active_jobs failed' };
      }
    },
  };
}

const getDeviceInventoryTool: AssistantTool = {
  definition: {
    type: 'function',
    function: {
      name: 'get_device_inventory',
      description:
        "Aggregate counts and sizes of media on the device, grouped by year, month, or media type. No asset URIs leave the device. Sizes may be null when the OS doesn't expose fileSize (common on Android, also iCloud-offloaded iOS assets). Slow on large libraries; do not call repeatedly.",
      parameters: {
        type: 'object',
        properties: {
          groupBy: {
            type: 'string',
            enum: ['year', 'month', 'type'],
            description: 'How to group the results.',
          },
          since: {
            type: 'string',
            description: 'ISO 8601 timestamp. Only assets created at or after this date.',
          },
        },
        required: ['groupBy'],
      },
    },
  },
  execute: async (input) => {
    try {
      const { groupBy, since } = safeInput<{
        groupBy: 'year' | 'month' | 'type';
        since?: string;
      }>(input);

      const perm = await MediaLibrary.getPermissionsAsync();
      if (!perm.granted) {
        return { error: 'media_permission_not_granted' };
      }

      const sinceMs = since ? Date.parse(since) : null;
      const createdAfter =
        sinceMs !== null && !isNaN(sinceMs) ? new Date(sinceMs) : undefined;

      // Paginate with cursor until done.
      type Bucket = { count: number; sizeBytes: number | null; hasMissingSize: boolean };
      const buckets = new Map<string, Bucket>();
      let cursor: string | undefined;
      let totalCount = 0;
      let totalSize: number | null = 0;
      let hasMissingTotal = false;

      do {
        const page = await MediaLibrary.getAssetsAsync({
          first: 1000,
          after: cursor,
          ...(createdAfter ? { createdAfter } : {}),
        });

        for (const asset of page.assets) {
          totalCount += 1;

          // fileSize is not in the published Asset type but is present at runtime
          // on some platforms — same cast pattern as autoBackupTask.ts.
          const size = typeof (asset as { fileSize?: number }).fileSize === 'number'
            ? (asset as { fileSize?: number }).fileSize!
            : null;
          if (size === null) {
            hasMissingTotal = true;
          } else if (totalSize !== null) {
            totalSize += size;
          }

          let key: string;
          if (groupBy === 'type') {
            key = asset.mediaType;
          } else {
            const d = new Date(asset.creationTime);
            const year = d.getFullYear().toString();
            const month = `${year}-${String(d.getMonth() + 1).padStart(2, '0')}`;
            key = groupBy === 'year' ? year : month;
          }

          const existing = buckets.get(key);
          if (!existing) {
            buckets.set(key, {
              count: 1,
              sizeBytes: size,
              hasMissingSize: size === null,
            });
          } else {
            existing.count += 1;
            if (size === null) {
              existing.hasMissingSize = true;
              // Once we have a missing size, the aggregate is unreliable — null it.
              existing.sizeBytes = null;
            } else if (existing.sizeBytes !== null) {
              existing.sizeBytes += size;
            }
          }
        }

        cursor = page.hasNextPage ? page.endCursor : undefined;
      } while (cursor);

      if (hasMissingTotal) totalSize = null;

      const sortedBuckets = Array.from(buckets.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, { count, sizeBytes }]) => ({ key, count, sizeBytes }));

      return {
        groupBy,
        buckets: sortedBuckets,
        total: { count: totalCount, sizeBytes: totalSize },
      };
    } catch (err) {
      return { error: err instanceof Error ? err.message : 'get_device_inventory failed' };
    }
  },
};

// ---------------------------------------------------------------------------
// Factory — builds the full tool list with injected deps.
// Called with { getJobsSnapshot: () => [] } at module load so ASSISTANT_TOOLS
// (used by FORBIDDEN_TOOL_NAMES guard and TOOL_NAMES) still works statically.
// ---------------------------------------------------------------------------

export type AssistantToolDeps = {
  getJobsSnapshot: () => JobRecord[];
  getActiveUploadsSnapshot: () => ReadonlyMap<string, ActiveUploadSnapshot>;
};

export function buildAssistantTools(
  deps: AssistantToolDeps,
): ReadonlyArray<AssistantTool> {
  return [
    listObjectsTool,
    getObjectMetadataTool,
    getFolderPreviewTool,
    getStorageStatsTool,
    existsTool,
    createFolderTool,
    moveTool,
    getRecentActivityTool,
    getBackupStatusTool,
    buildGetActiveJobsTool(deps.getJobsSnapshot, deps.getActiveUploadsSnapshot),
    getDeviceInventoryTool,
  ] as const;
}

export const ASSISTANT_TOOLS: ReadonlyArray<AssistantTool> = buildAssistantTools({
  getJobsSnapshot: () => [],
  getActiveUploadsSnapshot: () => new Map(),
});

export const TOOL_NAMES: ReadonlySet<string> = new Set(
  ASSISTANT_TOOLS.map((t) => t.definition.function.name),
);

// Safety guard: deletion tools must never be registered in this list.
// This assertion fires at module load time, making any accidental registration
// of a delete/remove tool immediately visible rather than silently slipping into
// the LLM's tool catalogue.
const FORBIDDEN_TOOL_NAMES = new Set(['delete', 'delete_object', 'delete_folder', 'remove']);
for (const t of ASSISTANT_TOOLS) {
  if (FORBIDDEN_TOOL_NAMES.has(t.definition.function.name)) {
    throw new Error(`Forbidden tool registered: ${t.definition.function.name}`);
  }
}
