import { computed, ref } from 'vue'

/**
 * Localisation.
 *
 * Deliberately small: one reactive language, one flat dictionary per language, and `t()` for lookups. A full
 * i18n framework would bring plural rules, message compilers and a bundler plugin for a UI whose text is
 * short labels and fixed sentences — all of which can be expressed as a dictionary plus a `{name}` substitution.
 *
 * Keys are dotted and grouped by area (`permission.read`, `toolbar.refresh`). A key that is missing falls back to
 * the other language and then to the key itself, so a half-migrated screen still shows something readable
 * instead of blank labels.
 */

/** The languages offered in the picker. */
export const LANGUAGES = [
  { value: 'zh-CN', name: '简体中文', icon: 'earth' },
  { value: 'en-US', name: 'English', icon: 'earth' },
]

/** localStorage key for the chosen language. */
const LANG_KEY = 'rc.lang'

/** @returns the language stored by a previous visit, or the browser's own preference. */
function readLang () {
  try {
    const saved = window.localStorage.getItem(LANG_KEY)
    if (saved === 'zh-CN' || saved === 'en-US') return saved
  } catch {
    /* storage unavailable: fall through to the browser preference */
  }
  const preferred = String(navigator.language ?? '')
  return preferred.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US'
}

/** The active language. */
export const lang = ref(readLang())

/** Every loaded dictionary, filled in by `dictionaries.js`. */
const dictionaries = new Map()

/**
 * Register one language's dictionary.
 * @param code - the language code.
 * @param entries - flat `{ key: text }` map.
 */
export function install (code, entries) {
  dictionaries.set(code, entries)
}

/** @returns the dictionary for a language, or an empty one. */
function dictionaryOf (code) {
  return dictionaries.get(code) ?? {}
}

/** @returns the fallback language for a code: Chinese for Chinese, English otherwise. */
function fallbackOf (code) {
  return code === 'zh-CN' ? 'en-US' : 'zh-CN'
}

/**
 * @param code - the language to switch to.
 *
 * Persisted immediately: the choice applies to every page load after this one, and a reader who switched to
 * English should not find the app back in Chinese after a reload.
 */
export function setLang (code) {
  lang.value = code === 'zh-CN' ? 'zh-CN' : 'en-US'
  try {
    window.localStorage.setItem(LANG_KEY, lang.value)
  } catch {
    /* in-memory only */
  }
  document.documentElement.lang = lang.value
}

/**
 * @param key - dotted dictionary key.
 * @param vars - values substituted into `{name}` placeholders.
 * @returns the localised text, falling back to the other language and then to the key.
 */
export function t (key, vars) {
  const primary = dictionaryOf(lang.value)[key]
  const secondary = dictionaryOf(fallbackOf(lang.value))[key]
  let text = primary ?? secondary
  if (text === undefined) return key
  if (vars !== undefined) {
    for (const [name, value] of Object.entries(vars)) {
      text = text.replaceAll(`{${name}}`, String(value))
    }
  }
  return text
}

/**
 * @param key - dotted dictionary key.
 * @param count - the number that decides the form.
 * @returns the localised text with `{count}` already substituted.
 *
 * Two forms are enough here: English distinguishes one from many, Chinese does not distinguish at all. A plural
 * rule engine would be more general than the handful of counted strings in this UI.
 */
export function tn (key, count) {
  const suffix = lang.value === 'en-US' && count === 1 ? '.one' : '.other'
  const text = dictionaryOf(lang.value)[key + suffix] ?? dictionaryOf(lang.value)[key]
  return text === undefined ? key : text.replaceAll('{count}', String(count))
}

/** @returns the language name to show in a picker, in its own language. */
export const langName = computed(() => LANGUAGES.find((entry) => entry.value === lang.value)?.name ?? lang.value)
