// Fallback for using MaterialIcons / MaterialCommunityIcons on Android and web.

import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { SymbolWeight, SymbolViewProps } from 'expo-symbols';
import { ComponentProps } from 'react';
import { OpaqueColorValue, type StyleProp, type TextStyle } from 'react-native';

type MaterialIconName = ComponentProps<typeof MaterialIcons>['name'];
type MaterialCommunityIconName = ComponentProps<typeof MaterialCommunityIcons>['name'];

type IconMappingValue =
  | MaterialIconName
  | { mci: MaterialCommunityIconName };

type IconMapping = Record<SymbolViewProps['name'], IconMappingValue>;
type IconSymbolName = keyof typeof MAPPING;

/**
 * Add your SF Symbols to MaterialIcons (or MaterialCommunityIcons) mappings here.
 * - see Material Icons in the [Icons Directory](https://icons.expo.fyi).
 * - see SF Symbols in the [SF Symbols](https://developer.apple.com/sf-symbols/) app.
 *
 * Values may be either a MaterialIcons name (string) or `{ mci: <name> }` for
 * MaterialCommunityIcons. MCI is used for icons that need a clean `-outline`
 * variant that MaterialIcons doesn't ship (e.g. `home-outline`).
 */
const MAPPING = {
  'house': { mci: 'home-outline' },
  'house.fill': 'home',
  'paperplane.fill': 'send',
  'chevron.left.forwardslash.chevron.right': 'code',
  'chevron.right': 'chevron-right',
  'chevron.left': 'chevron-left',
  'arrow.up': 'arrow-upward',
  'photo.on.rectangle': { mci: 'image-multiple-outline' },
  'folder': 'folder',
  'icloud.fill': 'cloud',
  'icloud': 'cloud-queue',
  'gearshape': { mci: 'cog-outline' },
  'list.bullet': 'view-list',
  'square.grid.2x2': 'view-module',
  'xmark': 'close',
  'arrow.down.to.line': 'file-download',
  'magnifyingglass': 'search',
  'xmark.circle.fill': 'cancel',
  'checkmark.icloud.fill': 'cloud-done',
  'line.3.horizontal.decrease.circle': 'filter-list',
  'line.3.horizontal.decrease.circle.fill': 'filter-list',
  'sparkles': { mci: 'star-four-points-outline' },
  'ellipsis': 'more-vert',
  'video.fill': { mci: 'video' },
  'doc': { mci: 'file-outline' },
} as IconMapping;

/**
 * An icon component that uses native SF Symbols on iOS, and Material Icons on Android and web.
 * This ensures a consistent look across platforms, and optimal resource usage.
 * Icon `name`s are based on SF Symbols and require manual mapping to Material Icons.
 */
export function IconSymbol({
  name,
  size = 24,
  color,
  style,
}: {
  name: IconSymbolName;
  size?: number;
  color: string | OpaqueColorValue;
  style?: StyleProp<TextStyle>;
  weight?: SymbolWeight;
}) {
  const mapped = MAPPING[name];
  if (typeof mapped === 'string') {
    return <MaterialIcons color={color} size={size} name={mapped} style={style} />;
  }
  return (
    <MaterialCommunityIcons color={color} size={size} name={mapped.mci} style={style} />
  );
}
