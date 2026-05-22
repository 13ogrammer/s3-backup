import { api } from './api';
import type { LLMToolDefinition } from './llm';

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

export const ASSISTANT_TOOLS: ReadonlyArray<AssistantTool> = [
  listObjectsTool,
  getObjectMetadataTool,
  getFolderPreviewTool,
  getStorageStatsTool,
  existsTool,
  createFolderTool,
  moveTool,
] as const;

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
