import React from 'react';
import { Text } from 'react-native';

import { Fonts, Radius, Type } from '@/constants/theme';

type Opts = { color: string; codeBg: string };

type Token =
  | { kind: 'text'; value: string }
  | { kind: 'bold'; value: string }
  | { kind: 'italic'; value: string }
  | { kind: 'code'; value: string };

// Returns true if the character at index i is a word character (letter, digit, or underscore).
function isWordChar(s: string, i: number): boolean {
  if (i < 0 || i >= s.length) return false;
  const c = s[i];
  return /\w/.test(c);
}

// Returns true if the character is whitespace or punctuation (valid open-boundary neighbour).
function isOpenBoundary(s: string, i: number): boolean {
  if (i < 0) return true; // start of string counts
  const c = s[i];
  return /[\s!"#$%&'()*+,\-./:;<=>?@[\\\]^`{|}~]/.test(c);
}

// Returns true if the character is non-whitespace (valid close-boundary neighbour before delimiter).
function isCloseBoundary(s: string, i: number): boolean {
  if (i < 0 || i >= s.length) return false;
  const c = s[i];
  return !/\s/.test(c);
}

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let literal = '';

  const flushLiteral = () => {
    if (literal.length > 0) {
      tokens.push({ kind: 'text', value: literal });
      literal = '';
    }
  };

  while (i < text.length) {
    // --- Code span: `...` ---
    if (text[i] === '`') {
      const start = i + 1;
      const end = text.indexOf('`', start);
      // Must close on the same line and have content
      if (end !== -1 && end > start && !text.slice(start, end).includes('\n')) {
        flushLiteral();
        tokens.push({ kind: 'code', value: text.slice(start, end) });
        i = end + 1;
        continue;
      }
    }

    // --- Bold: **...** ---
    if (text[i] === '*' && text[i + 1] === '*') {
      const start = i + 2;
      const closeIdx = text.indexOf('**', start);
      if (
        closeIdx !== -1 &&
        closeIdx > start &&
        !text.slice(start, closeIdx).includes('\n')
      ) {
        flushLiteral();
        tokens.push({ kind: 'bold', value: text.slice(start, closeIdx) });
        i = closeIdx + 2;
        continue;
      }
    }

    // --- Italic asterisk: *...* ---
    // Opening * must be at start-of-string or preceded by whitespace/punctuation,
    // and the character immediately after * must be non-whitespace.
    // Closing * must be immediately preceded by non-whitespace.
    // This prevents matching arithmetic like "2 * 3".
    if (text[i] === '*' && text[i + 1] !== '*') {
      const prevOk = isOpenBoundary(text, i - 1);
      const nextOk = i + 1 < text.length && !/\s/.test(text[i + 1]);
      if (prevOk && nextOk) {
        // Find matching close * before EOL
        let closeIdx = -1;
        for (let j = i + 2; j < text.length; j++) {
          if (text[j] === '*' && text[j + 1] !== '*' && isCloseBoundary(text, j - 1)) {
            if (text[j - 1] !== '\n') {
              closeIdx = j;
            }
            break;
          }
          if (text[j] === '\n') break;
        }
        if (closeIdx !== -1 && closeIdx > i + 1) {
          flushLiteral();
          tokens.push({ kind: 'italic', value: text.slice(i + 1, closeIdx) });
          i = closeIdx + 1;
          continue;
        }
      }
    }

    // --- Italic underscore: _..._ ---
    // Same word-boundary rule: opening _ must not be preceded by a word char,
    // and closing _ must not be followed by a word char.
    // This preserves snake_case.
    if (text[i] === '_') {
      const prevOk = !isWordChar(text, i - 1);
      const nextOk = i + 1 < text.length && text[i + 1] !== '_' && !/\s/.test(text[i + 1]);
      if (prevOk && nextOk) {
        let closeIdx = -1;
        for (let j = i + 2; j < text.length; j++) {
          if (text[j] === '_' && isCloseBoundary(text, j - 1) && !isWordChar(text, j + 1)) {
            closeIdx = j;
            break;
          }
          if (text[j] === '\n') break;
        }
        if (closeIdx !== -1 && closeIdx > i + 1) {
          flushLiteral();
          tokens.push({ kind: 'italic', value: text.slice(i + 1, closeIdx) });
          i = closeIdx + 1;
          continue;
        }
      }
    }

    // --- Literal character ---
    literal += text[i];
    i++;
  }

  flushLiteral();
  return tokens;
}

export function renderInlineMarkdown(
  text: string,
  opts: Opts,
): React.ReactNode {
  const tokens = tokenize(text);

  return tokens.map((token, index) => {
    switch (token.kind) {
      case 'bold':
        return (
          <Text key={index} style={Type.bodyStrong}>
            {token.value}
          </Text>
        );
      case 'italic':
        return (
          <Text key={index} style={{ fontStyle: 'italic' }}>
            {token.value}
          </Text>
        );
      case 'code':
        return (
          <Text
            key={index}
            style={{
              fontFamily: Fonts!.mono,
              backgroundColor: opts.codeBg,
              paddingHorizontal: 2,
              borderRadius: Radius.sm,
            }}>
            {token.value}
          </Text>
        );
      case 'text':
        return (
          <Text key={index} style={{ color: opts.color }}>
            {token.value}
          </Text>
        );
    }
  });
}
