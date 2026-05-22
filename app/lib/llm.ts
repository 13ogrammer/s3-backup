import type { SavedProvider } from './assistantConfig';

export type LLMTextContent = string;

export type LLMToolCall = {
  id: string;
  name: string;
  arguments: string;
};

export type LLMMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: LLMToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export type LLMToolDefinition = {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, unknown>;
      required?: string[];
    };
  };
};

export type LLMResponse = {
  content: string | null;
  toolCalls: LLMToolCall[];
  stopReason: 'stop' | 'tool_calls' | 'length' | 'other';
  inputTokens: number;
  outputTokens: number;
};

export class LLMError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = 'LLMError';
  }
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

export async function postChat(args: {
  provider: SavedProvider;
  system: string;
  messages: LLMMessage[];
  tools: LLMToolDefinition[];
  maxTokens?: number;
  signal?: AbortSignal;
}): Promise<LLMResponse> {
  const { provider, system, messages, tools, maxTokens = 4096, signal } = args;

  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  if (provider.apiKey?.trim()) {
    headers['authorization'] = `Bearer ${provider.apiKey.trim()}`;
  }
  // OpenRouter recommends these for free-tier eligibility & dashboard attribution.
  if (/openrouter\.ai/i.test(provider.baseUrl)) {
    headers['HTTP-Referer'] = 'https://github.com/13ogrammer/s3-backup';
    headers['X-Title'] = 's3-backup';
  }

  const wireMessages: unknown[] = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
      wireMessages.push({
        role: 'assistant',
        content: m.content,
        tool_calls: m.tool_calls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: tc.arguments },
        })),
      });
    } else {
      wireMessages.push(m);
    }
  }

  const body = {
    model: provider.model,
    messages: wireMessages,
    tools,
    tool_choice: 'auto' as const,
    max_tokens: maxTokens,
    stream: false,
  };

  const url = joinUrl(provider.baseUrl, 'chat/completions');

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    throw new LLMError(
      0,
      err instanceof Error ? `Network error: ${err.message}` : 'Network error',
    );
  }

  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const data = (await res.json()) as { error?: { message?: string } | string };
      if (typeof data.error === 'string') message = data.error;
      else if (data.error?.message) message = data.error.message;
    } catch {}
    throw new LLMError(res.status, message);
  }

  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    throw new LLMError(res.status, 'Response was not valid JSON');
  }

  return parseResponse(parsed);
}

function parseResponse(data: unknown): LLMResponse {
  const d = data as {
    choices?: Array<{
      message?: {
        content?: string | null;
        tool_calls?: Array<{
          id?: string;
          function?: { name?: string; arguments?: string | Record<string, unknown> };
        }>;
      };
      finish_reason?: string;
    }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };

  const choice = d.choices?.[0];
  const msg = choice?.message;
  const finishReason = choice?.finish_reason ?? 'stop';

  const toolCalls: LLMToolCall[] = (msg?.tool_calls ?? []).map((tc, i) => {
    const argsField = tc.function?.arguments;
    const argsString =
      typeof argsField === 'string'
        ? argsField
        : argsField
          ? JSON.stringify(argsField)
          : '{}';
    return {
      id: tc.id ?? `call_${i}`,
      name: tc.function?.name ?? '',
      arguments: argsString,
    };
  });

  let stopReason: LLMResponse['stopReason'] = 'other';
  if (toolCalls.length > 0 || finishReason === 'tool_calls') stopReason = 'tool_calls';
  else if (finishReason === 'stop') stopReason = 'stop';
  else if (finishReason === 'length') stopReason = 'length';

  return {
    content: msg?.content ?? null,
    toolCalls,
    stopReason,
    inputTokens: d.usage?.prompt_tokens ?? 0,
    outputTokens: d.usage?.completion_tokens ?? 0,
  };
}
