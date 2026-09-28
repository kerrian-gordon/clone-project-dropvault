export const THEME_FONTS = Object.freeze(['Inter', 'Arial', 'Georgia']);
export const THEME_SPACINGS = Object.freeze(['compact', 'comfortable']);
export const DEFAULT_THEME_SETTINGS = Object.freeze({
  colors: Object.freeze({
    background: '#f3f5f7',
    surface: '#ffffff',
    text: '#1b2330',
    accent: '#0061ff',
  }),
  font: 'Inter',
  spacing: 'comfortable',
});

const settingKeys = ['colors', 'font', 'spacing'];
const colorKeys = ['background', 'surface', 'text', 'accent'];

function exactKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

export function validThemeSettings(settings) {
  return exactKeys(settings, settingKeys) && exactKeys(settings.colors, colorKeys)
    && colorKeys.every((key) => typeof settings.colors[key] === 'string'
      && /^#[0-9a-fA-F]{6}$/u.test(settings.colors[key]))
    && THEME_FONTS.includes(settings.font)
    && THEME_SPACINGS.includes(settings.spacing);
}

export function validThemeName(name) {
  return typeof name === 'string' && name.length <= 80 && name.trim().length > 0
    && !/[\u0000-\u001f\u007f]/u.test(name);
}

export function validCreatorName(name) {
  return typeof name === 'string' && name.length <= 50 && name.trim().length > 0
    && !/[\u0000-\u001f\u007f]/u.test(name);
}

function linearChannel(value) {
  const channel = value / 255;
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

function luminance(hex) {
  const channels = [1, 3, 5].map((position) =>
    linearChannel(parseInt(hex.slice(position, position + 2), 16)));
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

export function contrastRatio(first, second) {
  const lighter = Math.max(luminance(first), luminance(second));
  const darker = Math.min(luminance(first), luminance(second));
  return (lighter + 0.05) / (darker + 0.05);
}

export function themeContrastIssues(settings) {
  if (!validThemeSettings(settings)) return ['Invalid theme settings'];
  const { background, surface, text, accent } = settings.colors;
  const pairs = [
    ['Text on background', text, background],
    ['Text on cards', text, surface],
    ['Accent on background', accent, background],
    ['Accent on cards', accent, surface],
  ];
  return pairs.filter(([, foreground, backdrop]) => contrastRatio(foreground, backdrop) < 4.5)
    .map(([label]) => `${label} needs more contrast`);
}
