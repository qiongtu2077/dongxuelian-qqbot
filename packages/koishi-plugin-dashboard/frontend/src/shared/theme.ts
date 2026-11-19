/** 两个控制台共用的主题清单，色板同时用于实页和选项预览。 */
export const themes = [
  { id: 'dark-gold', label: '暗金', dark: true, colors: ['#151311', '#211D18', '#F7EEE0', '#E8BC67', '#17120B'] },
  { id: 'light', label: '昼白', dark: false, colors: ['#F6F8FC', '#FFFFFF', '#182230', '#785400', '#FFFFFF'] },
  { id: 'forest-green', label: '环保绿', dark: false, colors: ['#F2F7F2', '#FFFFFF', '#173024', '#206747', '#FFFFFF'] },
  { id: 'monet-purple', label: '莫奈紫', dark: false, colors: ['#F5F2FB', '#FFFDFF', '#2D2344', '#6647A8', '#FFFFFF'] },
  { id: 'ocean-cyan', label: '海盐青', dark: false, colors: ['#EEF8FA', '#FCFEFF', '#12323B', '#116678', '#FFFFFF'] },
  { id: 'graphite-blue', label: '石墨蓝', dark: true, colors: ['#111827', '#1A2537', '#E7EDF7', '#8BB5FF', '#111827'] },
  { id: 'clear-water', label: '清水紫', dark: true, colors: ['#15152C', '#202542', '#ECEBFF', '#ABACFF', '#16152B'] },
  { id: 'crimson-red', label: '赤焰红', dark: true, colors: ['#1B151B', '#291D26', '#F3E6ED', '#E99CAC', '#22121A'] },
  { id: 'sakura-pink', label: '樱花粉', dark: false, colors: ['#F9EFF4', '#FFFBFD', '#3B2232', '#9E3565', '#FFFFFF'] },
]
export const THEME_KEY = 'dashboard_theme'

/** 读已有的主题偏好，缺省值由各入口指定。 */
export function applyTheme(fallback: string, choice = localStorage.getItem(THEME_KEY)): string {
  const item = themes.find(theme => theme.id === choice) ?? themes.find(theme => theme.id === fallback)!
  const html = document.documentElement
  html.dataset.theme = item.id
  html.dataset.appearance = item.dark ? 'dark' : 'light'
  const [background, panel, text, accent, onAccent] = item.colors
  html.style.setProperty('--bg', background)
  html.style.setProperty('--card', panel)
  html.style.setProperty('--text', text)
  html.style.setProperty('--accent', accent)
  html.style.setProperty('--on-accent', onAccent)
  return item.id
}
