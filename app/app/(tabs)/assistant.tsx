import { useBottomTabBarHeight } from '@react-navigation/bottom-tabs';
import { useFocusEffect, useNavigation } from 'expo-router';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  Animated,
  Easing,
  FlatList,
  Keyboard,
  Platform,
  Pressable,
  StyleSheet,
  View,
} from 'react-native';

import { ChatComposer } from '@/components/assistant/ChatComposer';
import { EmptyState } from '@/components/assistant/EmptyState';
import { MessageBubble } from '@/components/assistant/MessageBubble';
import { PrivacyNotice } from '@/components/assistant/PrivacyNotice';
import { ToolGroupCard, type ToolEntry } from '@/components/assistant/ToolGroupCard';
import { TypingDots } from '@/components/assistant/TypingDots';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Colors, Spacing, Type } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';
import {
  acknowledgePrivacy,
  bumpAssistantSessionResetVersion,
  getActiveProvider,
  getAssistantContextPrefix,
  getAssistantSessionResetVersion,
  isPrivacyAcknowledged,
  isProviderUsable,
  type SavedProvider,
} from '@/lib/assistantConfig';
import { LLMError, postChat, type LLMMessage, type LLMToolCall } from '@/lib/llm';
import { ASSISTANT_TOOLS, TOOL_NAMES } from '@/lib/assistantTools';

const MAX_TURNS = 20;

type ChatMessage =
  | { id: string; role: 'user'; text: string }
  | { id: string; role: 'assistant'; text: string }
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

type SessionState = {
  messages: ChatMessage[];
  turnCount: number;
  inputTokens: number;
  outputTokens: number;
  busy: boolean;
};

const EMPTY_SESSION: SessionState = {
  messages: [],
  turnCount: 0,
  inputTokens: 0,
  outputTokens: 0,
  busy: false,
};

function uid(): string {
  return Math.random().toString(36).slice(2, 10);
}

function buildSystemPrompt(contextPrefix: string | null): string {
  const base =
    'You are a helpful assistant for an S3 backup app. You can answer questions about the user\'s S3 bucket using the tools provided. You cannot modify, delete, or move any files — only read and describe what exists.';
  if (contextPrefix) {
    return `${base}\n\nThe user is currently browsing the folder: "${contextPrefix}". Use this as the default context scope for queries unless instructed otherwise.`;
  }
  return base;
}

function parseToolArguments(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return { _raw: raw };
  }
}

type RenderItem =
  | { type: 'bubble'; id: string; role: 'user' | 'assistant'; text: string }
  | { type: 'toolGroup'; id: string; tools: ToolEntry[] }
  | { type: 'typing'; id: 'typing-indicator' };

function buildRenderItems(messages: ChatMessage[], showTyping: boolean): RenderItem[] {
  const items: RenderItem[] = [];
  let currentGroup: ToolEntry[] = [];
  let groupAnchorId: string | null = null;

  const flushGroup = () => {
    if (currentGroup.length > 0 && groupAnchorId) {
      items.push({ type: 'toolGroup', id: groupAnchorId, tools: currentGroup });
      currentGroup = [];
      groupAnchorId = null;
    }
  };

  for (const m of messages) {
    if (m.role === 'tool') {
      if (groupAnchorId === null) groupAnchorId = m.id;
      currentGroup.push({
        id: m.id,
        name: m.name,
        input: m.input,
        status: m.status,
        result: m.result,
        errorMessage: m.errorMessage,
      });
    } else {
      flushGroup();
      items.push({ type: 'bubble', id: m.id, role: m.role, text: m.text });
    }
  }
  flushGroup();

  if (showTyping) {
    items.push({ type: 'typing', id: 'typing-indicator' });
  }

  return items;
}

export default function AssistantScreen() {
  const colorScheme = useColorScheme() ?? 'light';
  const colors = Colors[colorScheme];
  const navigation = useNavigation();

  const [provider, setProvider] = useState<SavedProvider | null>(null);
  const [privacyAcked, setPrivacyAcked] = useState(false);
  const [contextPrefix, setContextPrefix] = useState<string | null>(null);
  const [session, setSession] = useState<SessionState>(EMPTY_SESSION);
  const [input, setInput] = useState('');
  const [capReached, setCapReached] = useState(false);

  const sessionResetVersionRef = useRef<number>(0);
  const listRef = useRef<FlatList>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Manual keyboard-driven padding for the chat surface.
  //
  // The keyboard's reported endCoordinates.height is measured from the bottom
  // of the screen, but our content area sits above the bottom tab bar. We
  // subtract only the tab bar's *content portion* (i.e. excluding the safe-
  // area inset, which the keyboard already covers) to avoid over-correcting.
  const tabBarHeight = useBottomTabBarHeight();
  const insets = useSafeAreaInsets();
  const tabBarContentHeight = Math.max(0, tabBarHeight - insets.bottom);
  const keyboardPad = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const show = Keyboard.addListener(showEvent, (e) => {
      const target = Math.max(0, e.endCoordinates.height - tabBarContentHeight);
      if (Platform.OS === 'ios') {
        Animated.timing(keyboardPad, {
          toValue: target,
          duration: e.duration ?? 250,
          easing: Easing.bezier(0.17, 0.59, 0.4, 0.77),
          useNativeDriver: false,
        }).start();
      } else {
        keyboardPad.setValue(target);
      }
    });
    const hide = Keyboard.addListener(hideEvent, (e) => {
      if (Platform.OS === 'ios') {
        Animated.timing(keyboardPad, {
          toValue: 0,
          duration: e.duration ?? 250,
          easing: Easing.bezier(0.17, 0.59, 0.4, 0.77),
          useNativeDriver: false,
        }).start();
      } else {
        keyboardPad.setValue(0);
      }
    });
    return () => {
      show.remove();
      hide.remove();
    };
  }, [keyboardPad, tabBarContentHeight]);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      async function load() {
        const [active, acked, prefix, resetVersion] = await Promise.all([
          getActiveProvider(),
          isPrivacyAcknowledged(),
          getAssistantContextPrefix(),
          getAssistantSessionResetVersion(),
        ]);
        if (cancelled) return;

        setProvider(active);
        setPrivacyAcked(acked);
        setContextPrefix(prefix);

        if (resetVersion !== sessionResetVersionRef.current) {
          sessionResetVersionRef.current = resetVersion;
          setSession(EMPTY_SESSION);
          setCapReached(false);
          setInput('');
        }
      }
      load();
      return () => { cancelled = true; };
    }, []),
  );

  const totalTokens = session.inputTokens + session.outputTokens;
  const usable = isProviderUsable(provider);

  const hasMessages = session.messages.length > 0;
  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <View style={styles.headerRight}>
          {totalTokens > 0 ? (
            <ThemedText style={[Type.meta, { color: colors.muted }]}>
              {totalTokens.toLocaleString()} tokens
            </ThemedText>
          ) : null}
          {hasMessages ? (
            <Pressable
              onPress={handleClearChat}
              accessibilityRole="button"
              accessibilityLabel="Clear chat"
              hitSlop={8}
              style={({ pressed }) => [styles.headerButton, { opacity: pressed ? 0.6 : 1 }]}>
              <ThemedText style={[Type.meta, { color: colors.tint, fontWeight: '600' }]}>
                Clear
              </ThemedText>
            </Pressable>
          ) : null}
        </View>
      ),
    });
  }, [navigation, totalTokens, colors.muted, colors.tint, hasMessages]);

  async function handleSend() {
    const trimmed = input.trim();
    if (!trimmed || !usable || session.busy || capReached) return;

    setInput('');

    const userMsg: ChatMessage = { id: uid(), role: 'user', text: trimmed };
    setSession((prev) => ({
      ...prev,
      busy: true,
      messages: [...prev.messages, userMsg],
    }));

    const llmHistory: LLMMessage[] = [];
    const allMessages = [...session.messages, userMsg];
    for (const m of allMessages) {
      if (m.role === 'user') {
        llmHistory.push({ role: 'user', content: m.text });
      } else if (m.role === 'assistant') {
        llmHistory.push({ role: 'assistant', content: m.text });
      }
    }

    await runLoop(allMessages, llmHistory);
  }

  async function runLoop(
    initialMessages: ChatMessage[],
    initialHistory: LLMMessage[],
  ) {
    const currentProvider = provider!;
    const system = buildSystemPrompt(contextPrefix);
    const toolDefs = ASSISTANT_TOOLS.map((t) => t.definition);

    const controller = new AbortController();
    abortRef.current = controller;

    let currentMessages = [...initialMessages];
    let llmMessages = [...initialHistory];
    let localTurnCount = session.turnCount;
    let localInputTokens = session.inputTokens;
    let localOutputTokens = session.outputTokens;

    // Loop guard: if the same tool name returns the same error string twice in
    // a row, the model is almost certainly stuck — break and tell the user.
    let lastErrorSignature: string | null = null;
    let repeatErrorCount = 0;

    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        if (controller.signal.aborted) break;

        let resp;
        try {
          resp = await postChat({
            provider: currentProvider,
            system,
            messages: llmMessages,
            tools: toolDefs,
            signal: controller.signal,
          });
        } catch (err) {
          if (controller.signal.aborted) {
            const stopMsg: ChatMessage = {
              id: uid(),
              role: 'assistant',
              text: 'Stopped.',
            };
            currentMessages = [...currentMessages, stopMsg];
            setSession((prev) => ({
              ...prev,
              busy: false,
              messages: currentMessages,
              turnCount: localTurnCount,
              inputTokens: localInputTokens,
              outputTokens: localOutputTokens,
            }));
            return;
          }
          const errMsg =
            err instanceof LLMError
              ? `LLM error (${err.status || 'network'}): ${err.message}`
              : err instanceof Error
                ? err.message
                : 'Unknown error';
          const errBubble: ChatMessage = { id: uid(), role: 'assistant', text: errMsg };
          currentMessages = [...currentMessages, errBubble];
          setSession((prev) => ({
            ...prev,
            busy: false,
            messages: currentMessages,
            turnCount: localTurnCount,
            inputTokens: localInputTokens,
            outputTokens: localOutputTokens,
          }));
          return;
        }

        localInputTokens += resp.inputTokens;
        localOutputTokens += resp.outputTokens;

        // Render assistant text if any.
        if (resp.content && resp.content.trim()) {
          const aMsg: ChatMessage = { id: uid(), role: 'assistant', text: resp.content };
          currentMessages = [...currentMessages, aMsg];
        }

        // Push assistant turn into history (must include tool_calls if present).
        llmMessages = [
          ...llmMessages,
          resp.toolCalls.length > 0
            ? {
                role: 'assistant',
                content: resp.content,
                tool_calls: resp.toolCalls,
              }
            : { role: 'assistant', content: resp.content ?? '' },
        ];

        if (resp.stopReason !== 'tool_calls' || resp.toolCalls.length === 0) break;

        // Execute tool calls.
        const toolMessages: LLMMessage[] = [];

        for (const call of resp.toolCalls) {
          const parsedArgs = parseToolArguments(call.arguments);
          const tool = ASSISTANT_TOOLS.find((t) => t.definition.function.name === call.name);

          if (!tool || !TOOL_NAMES.has(call.name)) {
            const unknownCard: ChatMessage = {
              id: uid(),
              role: 'tool',
              toolCallId: call.id,
              name: call.name,
              input: parsedArgs,
              status: 'error',
              errorMessage: 'Unknown tool',
            };
            currentMessages = [...currentMessages, unknownCard];
            toolMessages.push({
              role: 'tool',
              tool_call_id: call.id,
              content: JSON.stringify({ error: 'unknown tool' }),
            });
            continue;
          }

          const pendingCard: ChatMessage = {
            id: uid(),
            role: 'tool',
            toolCallId: call.id,
            name: call.name,
            input: parsedArgs,
            status: 'pending',
          };
          currentMessages = [...currentMessages, pendingCard];
          setSession((prev) => ({
            ...prev,
            messages: currentMessages,
            turnCount: localTurnCount,
            inputTokens: localInputTokens,
            outputTokens: localOutputTokens,
          }));

          const result = await tool.execute(parsedArgs);
          const isError =
            result !== null &&
            typeof result === 'object' &&
            'error' in (result as object) &&
            typeof (result as { error: unknown }).error === 'string';

          const resolvedCard: ChatMessage = isError
            ? {
                ...pendingCard,
                status: 'error',
                errorMessage: (result as { error: string }).error,
              }
            : { ...pendingCard, status: 'ok', result };

          currentMessages = currentMessages.map((m) =>
            m.id === pendingCard.id ? resolvedCard : m,
          );

          toolMessages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: JSON.stringify(result),
          });
        }

        llmMessages = [...llmMessages, ...toolMessages];

        // Loop guard: if every tool call this turn errored with the same
        // signature as last turn, the model is stuck. Break and surface a
        // clear assistant message instead of grinding through MAX_TURNS.
        const errorSignatures = resp.toolCalls
          .map((c) => {
            const tm = toolMessages.find((m) => m.role === 'tool' && m.tool_call_id === c.id);
            if (!tm || tm.role !== 'tool') return null;
            try {
              const parsed = JSON.parse(tm.content) as { error?: unknown };
              if (typeof parsed.error === 'string') return `${c.name}:${parsed.error}`;
            } catch {}
            return null;
          })
          .filter((s): s is string => s !== null);
        const allErrored =
          errorSignatures.length > 0 && errorSignatures.length === resp.toolCalls.length;
        const turnSignature = allErrored ? errorSignatures.join('|') : null;
        if (turnSignature !== null && turnSignature === lastErrorSignature) {
          repeatErrorCount += 1;
        } else {
          repeatErrorCount = turnSignature ? 1 : 0;
        }
        lastErrorSignature = turnSignature;

        if (repeatErrorCount >= 2) {
          const stuckMsg: ChatMessage = {
            id: uid(),
            role: 'assistant',
            text: `The model is repeating a failing tool call (${turnSignature ?? ''}). Stopping to avoid running up cost. Rephrase your question, switch to a stronger model, or clear the chat and try again.`,
          };
          currentMessages = [...currentMessages, stuckMsg];
          break;
        }

        localTurnCount += 1;

        if (localTurnCount >= MAX_TURNS) {
          setCapReached(true);
          break;
        }
      }
    } finally {
      abortRef.current = null;
      setSession((prev) => ({
        ...prev,
        busy: false,
        messages: currentMessages,
        turnCount: localTurnCount,
        inputTokens: localInputTokens,
        outputTokens: localOutputTokens,
      }));
      setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 100);
    }
  }

  function handleStop() {
    abortRef.current?.abort();
  }

  async function handleClearChat() {
    abortRef.current?.abort();
    setSession(EMPTY_SESSION);
    setCapReached(false);
    setInput('');
    await bumpAssistantSessionResetVersion();
    sessionResetVersionRef.current = await getAssistantSessionResetVersion();
  }

  async function handleAcknowledge() {
    await acknowledgePrivacy();
    setPrivacyAcked(true);
  }

  if (!usable) {
    return (
      <ThemedView style={styles.flex}>
        <EmptyState provider={provider} />
      </ThemedView>
    );
  }

  const lastMessage = session.messages[session.messages.length - 1];
  const lastIsPendingTool = lastMessage?.role === 'tool' && lastMessage.status === 'pending';
  const showTyping = session.busy && !lastIsPendingTool;
  const renderItems = buildRenderItems(session.messages, showTyping);

  return (
    <ThemedView style={styles.flex}>
      <Animated.View style={[styles.flex, { paddingBottom: keyboardPad }]}>
        <FlatList
          ref={listRef}
          data={renderItems}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.list}
          onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: false })}
          ListEmptyComponent={
            <View style={styles.emptyChat}>
              <ThemedText style={[Type.body, { color: colors.muted, textAlign: 'center' }]}>
                Ask anything about your S3 bucket.
              </ThemedText>
              {provider ? (
                <ThemedText
                  style={[Type.meta, { color: colors.muted, textAlign: 'center', marginTop: Spacing.sm }]}>
                  Using {provider.name} · {provider.model}
                </ThemedText>
              ) : null}
            </View>
          }
          renderItem={({ item }) => {
            if (item.type === 'bubble') {
              return <MessageBubble role={item.role} text={item.text} />;
            }
            if (item.type === 'toolGroup') {
              return <ToolGroupCard tools={item.tools} />;
            }
            return (
              <View style={styles.typingRow}>
                <TypingDots color={colors.muted} />
              </View>
            );
          }}
          ListFooterComponent={
            capReached ? (
              <View style={[styles.capBanner, { backgroundColor: colors.dangerSoft }]}>
                <ThemedText style={[Type.label, { color: colors.danger, textAlign: 'center' }]}>
                  20-turn limit reached. Each turn is one round of LLM + tool calls; the cap
                  exists so a runaway loop can&apos;t burn through your credits.
                </ThemedText>
                <Pressable
                  onPress={handleClearChat}
                  accessibilityRole="button"
                  style={({ pressed }) => [
                    styles.capButton,
                    { backgroundColor: colors.danger, opacity: pressed ? 0.7 : 1 },
                  ]}>
                  <ThemedText style={[Type.bodyStrong, { color: colors.onAccent }]}>
                    Start a new chat
                  </ThemedText>
                </Pressable>
              </View>
            ) : null
          }
        />

        <ChatComposer
          value={input}
          onChangeText={setInput}
          onSend={handleSend}
          onStop={handleStop}
          busy={session.busy}
          disabled={capReached}
        />

        {usable && !privacyAcked && provider && (
          <PrivacyNotice provider={provider} onAcknowledge={handleAcknowledge} />
        )}
      </Animated.View>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  list: {
    paddingTop: Spacing.md,
    paddingBottom: Spacing.sm,
  },
  emptyChat: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: Spacing.xl,
    marginTop: 80,
  },
  capBanner: {
    marginHorizontal: Spacing.lg,
    marginBottom: Spacing.md,
    padding: Spacing.md,
    borderRadius: 8,
    gap: Spacing.sm,
  },
  capButton: {
    marginTop: Spacing.xs,
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
  },
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    paddingRight: Spacing.md,
  },
  headerButton: {
    paddingVertical: 4,
  },
  typingRow: {
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    alignItems: 'flex-start',
  },
});
