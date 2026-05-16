import { Platform } from 'react-native';

const tintLight = '#6366f1';
const tintDark = '#818cf8';

export const Colors = {
  light: {
    text: '#0f172a',
    muted: '#64748b',
    background: '#f8fafc',
    surface: '#ffffff',
    surfaceMuted: '#f1f5f9',
    surfaceElevated: '#ffffff',
    tint: tintLight,
    accentSoft: '#eef2ff',
    icon: '#94a3b8',
    tabIconDefault: '#94a3b8',
    tabIconSelected: tintLight,
    border: '#e2e8f0',
    divider: '#e2e8f0',
    danger: '#dc2626',
    onAccent: '#ffffff',
    skeletonBase: '#E5E7EB',
    skeletonHighlight: '#F3F4F6',
  },
  dark: {
    text: '#e2e8f0',
    muted: '#94a3b8',
    background: '#0b0f17',
    surface: '#1a2030',
    surfaceMuted: '#141a26',
    surfaceElevated: '#212a3d',
    tint: tintDark,
    accentSoft: '#1e1b4b',
    icon: '#64748b',
    tabIconDefault: '#64748b',
    tabIconSelected: tintDark,
    border: '#1e293b',
    divider: '#1e293b',
    danger: '#f87171',
    onAccent: '#0b0f17',
    skeletonBase: '#1F2937',
    skeletonHighlight: '#374151',
  },
};

export const Radius = {
  sm: 8,
  md: 10,
  lg: 14,
  xl: 20,
  pill: 999,
};

export const Spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
};

export const Shadow = {
  card: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 3,
    elevation: 1,
  },
  cardElevated: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.1,
    shadowRadius: 12,
    elevation: 4,
  },
};

export const Type = {
  largeTitle: { fontSize: 32, fontWeight: '700' as const, lineHeight: 38 },
  title: { fontSize: 24, fontWeight: '700' as const, lineHeight: 30 },
  section: { fontSize: 20, fontWeight: '600' as const, lineHeight: 26 },
  body: { fontSize: 16, fontWeight: '400' as const, lineHeight: 22 },
  bodyStrong: { fontSize: 16, fontWeight: '600' as const, lineHeight: 22 },
  label: { fontSize: 14, fontWeight: '500' as const, lineHeight: 20 },
  meta: { fontSize: 12, fontWeight: '500' as const, lineHeight: 16 },
};

export const Fonts = Platform.select({
  ios: {
    sans: 'system-ui',
    serif: 'ui-serif',
    rounded: 'ui-rounded',
    mono: 'ui-monospace',
  },
  default: {
    sans: 'normal',
    serif: 'serif',
    rounded: 'normal',
    mono: 'monospace',
  },
  web: {
    sans: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
    serif: "Georgia, 'Times New Roman', serif",
    rounded: "'SF Pro Rounded', 'Hiragino Maru Gothic ProN', Meiryo, 'MS PGothic', sans-serif",
    mono: "SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
  },
});
