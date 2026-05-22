import { api } from './api';
import type { LLMToolDefinition } from './llm';

export type ToolExecutor = (input: unknown) => Promise<unknown>;

export type AssistantTool = {
  definition: LLMToolDefinition;
  execute: ToolExecutor;
};

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

export const ASSISTANT_TOOLS: ReadonlyArray<AssistantTool> = [
  listObjectsTool,
  getObjectMetadataTool,
  getFolderPreviewTool,
  getStorageStatsTool,
  existsTool,
] as const;

export const TOOL_NAMES: ReadonlySet<string> = new Set(
  ASSISTANT_TOOLS.map((t) => t.definition.function.name),
);
