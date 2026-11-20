/**
 * The page's two languages: Chinese and English.
 *
 * One small store, no framework: the chosen language (remembered across restarts),
 * the strings the chrome needs, and a way to hear about a change. Anything that shows
 * text asks for it when it draws and subscribes with `onLanguage`, so the open
 * Settings panel relabels itself the moment the switch is flicked.
 *
 * What the *cat* says is not here: those lines live next to the reminder that picks
 * them, in reminders.js.
 *
 * Nothing here needs a DOM. localStorage and navigator are both optional, so the
 * module also loads in a plain Node process (the behaviour simulation imports the
 * reminders, which import this).
 */

export const LANGUAGES = ['zh', 'en'];

const STORE = 'desktop-cat.lang';

/**
 * The chrome's strings. A value is either the text or a function of its arguments,
 * which `t()` calls for you.
 */
const UI = {
  zh: {
    settings: '设置',
    volume: '音量',
    catSize: '猫咪大小',
    fishSize: '小鱼大小',
    fishAsBigAsCat: '和猫一样大！',
    breakReminders: '休息提醒',
    eyesReminder: '护眼提醒',
    walkReminder: '走动间隔',
    reminderOff: '关闭',
    reminderEvery: (minutes) => `${minutes} 分钟`,
    reminderAria: (label) => `${label}（分钟，最小一档为关闭）`,
    languageAria: '界面语言',
    save: '保存',
    cancel: '取消',
    restoreDefaults: '恢复默认',
  },
  en: {
    settings: 'Settings',
    volume: 'Volume',
    catSize: 'Cat size',
    fishSize: 'Fish size',
    fishAsBigAsCat: 'as big as the cat!',
    breakReminders: 'Break reminders',
    eyesReminder: 'Eye rest',
    walkReminder: 'Move interval',
    reminderOff: 'Off',
    reminderEvery: (minutes) => `${minutes} min`,
    reminderAria: (label) => `${label} in minutes; the lowest notch turns it off`,
    languageAria: 'Interface language',
    save: 'Save',
    cancel: 'Cancel',
    restoreDefaults: 'Restore defaults',
  },
};

/** Read the saved choice, falling back to the system's language, then English. */
function initial() {
  try {
    const saved = localStorage.getItem(STORE);
    if (LANGUAGES.includes(saved)) return saved;
  } catch {
    // No storage (or it is blocked): fall through to the system language.
  }
  const tag = typeof navigator === 'undefined' ? '' : navigator.language || '';
  return tag.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

let current = initial();
const listeners = new Set();

/** The language in use: 'zh' or 'en'. */
export function language() {
  return current;
}

/** Switch language and tell everyone who is listening. Unknown tags are ignored. */
export function setLanguage(next) {
  if (!LANGUAGES.includes(next) || next === current) return;
  current = next;
  try {
    localStorage.setItem(STORE, next);
  } catch {
    // Storage unavailable: the choice still holds for this run.
  }
  for (const listener of [...listeners]) listener(current);
}

/** Subscribe to language changes. Returns the unsubscribe function. */
export function onLanguage(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * A chrome string in the current language. Extra arguments go to the entries that
 * take them, e.g. `t('reminderEvery', 20)`.
 */
export function t(key, ...args) {
  const entry = UI[current]?.[key] ?? UI.zh[key];
  if (entry == null) return key;
  return typeof entry === 'function' ? entry(...args) : entry;
}
