/**
 * Model family marks.
 *
 * The picker lists whatever the Host offers — well over a hundred models, changing with every provider
 * that gets configured — so a model is matched by keyword rather than by an enumeration that would go
 * stale.
 *
 * Artwork comes from @lobehub/icons-static-svg (MIT), which carries the real brand logos, including the
 * families simple-icons lacks: OpenAI (removed from that set), xAI/Grok, Zhipu/GLM, Tencent Hunyuan and
 * Xiaomi MiMo. Each SVG is inlined through Vite's `?raw`, so there is no extra request and the mark can
 * inherit the theme (monochrome files use `currentColor`; `-color` files carry the brand palette).
 *
 * A family with no artwork falls back to the drawn glyphs in AppIcon rather than showing nothing.
 */
import alibabacloud from '@lobehub/icons-static-svg/icons/alibabacloud-color.svg?raw'
import claude from '@lobehub/icons-static-svg/icons/claude-color.svg?raw'
import deepseek from '@lobehub/icons-static-svg/icons/deepseek-color.svg?raw'
import gemini from '@lobehub/icons-static-svg/icons/gemini-color.svg?raw'
import huggingface from '@lobehub/icons-static-svg/icons/huggingface-color.svg?raw'
import hunyuan from '@lobehub/icons-static-svg/icons/hunyuan-color.svg?raw'
import kimi from '@lobehub/icons-static-svg/icons/kimi-color.svg?raw'
import meta from '@lobehub/icons-static-svg/icons/meta-color.svg?raw'
import minimax from '@lobehub/icons-static-svg/icons/minimax-color.svg?raw'
import mistral from '@lobehub/icons-static-svg/icons/mistral-color.svg?raw'
import ollama from '@lobehub/icons-static-svg/icons/ollama.svg?raw'
import openai from '@lobehub/icons-static-svg/icons/openai.svg?raw'
import qwen from '@lobehub/icons-static-svg/icons/qwen-color.svg?raw'
import tencent from '@lobehub/icons-static-svg/icons/tencent-brand.svg?raw'
import xai from '@lobehub/icons-static-svg/icons/xai.svg?raw'
import xiaomimimo from '@lobehub/icons-static-svg/icons/xiaomimimo.svg?raw'
import zhipu from '@lobehub/icons-static-svg/icons/zhipu-color.svg?raw'

/** @returns the SVG markup for a mark, with its fixed size stripped so CSS can own it. */
function artwork (svg) {
  return svg
    .replace(/width="1em"/gu, '')
    .replace(/height="1em"/gu, '')
    .replace(/style="flex:none;line-height:1"/gu, '')
}

/** Keyword rules, most specific first. */
const FAMILIES = [
  // MiMo before anything generic: `xiaomi/mimo-*` must not be read as some other family.
  { match: /mimo|xiaomi/i, svg: xiaomimimo, title: 'Xiaomi MiMo' },
  { match: /\bhy\d|hunyuan|tencent/i, svg: hunyuan, title: 'Tencent Hunyuan' },
  { match: /glm|z-?ai|zhipu|chatglm/i, svg: zhipu, title: 'Zhipu GLM' },
  { match: /grok|xai/i, svg: xai, title: 'xAI' },
  { match: /gpt|openai|chatgpt|codex|davinci/i, svg: openai, title: 'OpenAI' },
  { match: /claude|sonnet|opus|haiku|anthropic/i, svg: claude, title: 'Claude' },
  { match: /gemini|gemma|palm\b/i, svg: gemini, title: 'Gemini' },
  { match: /llama|meta\b|opt\b/i, svg: meta, title: 'Meta' },
  { match: /deepseek/i, svg: deepseek, title: 'DeepSeek' },
  { match: /qwen|qwq|tongyi/i, svg: qwen, title: 'Qwen' },
  { match: /kimi|moonshot/i, svg: kimi, title: 'Kimi' },
  { match: /minimax|abab/i, svg: minimax, title: 'MiniMax' },
  { match: /mistral|mixtral|codestral|magistral|devstral/i, svg: mistral, title: 'Mistral' },
  { match: /ollama/i, svg: ollama, title: 'Ollama' },
  { match: /huggingface|hf\b/i, svg: huggingface, title: 'Hugging Face' },
  { match: /alibaba|qianwen/i, svg: alibabacloud, title: 'Alibaba Cloud' },
  { match: /doubao|bytedance|seed\b/i, svg: tencent, title: 'ByteDance' },
]

/** AppIcon glyphs used when a family has no artwork. */
const GLYPHS = [
  { match: /mimo|xiaomi/i, icon: 'cpu' },
  { match: /\bhy\d|hunyuan|tencent/i, icon: 'cpu' },
  { match: /glm|z-?ai|zhipu|chatglm/i, icon: 'modelQwen' },
  { match: /grok|xai/i, icon: 'modelGrok' },
  { match: /gpt|openai|chatgpt|codex|davinci/i, icon: 'modelOpenai' },
  { match: /claude|sonnet|opus|haiku|anthropic/i, icon: 'modelAnthropic' },
  { match: /gemini|gemma|palm\b/i, icon: 'modelGoogle' },
  { match: /llama|meta\b|opt\b/i, icon: 'modelMeta' },
  { match: /deepseek/i, icon: 'modelDeepseek' },
  { match: /qwen|qwq|tongyi/i, icon: 'modelQwen' },
  { match: /mistral|mixtral|codestral|magistral|devstral/i, icon: 'modelMistral' },
]

/** @returns the family entry for a model, or undefined. */
function familyOf (id, name) {
  const haystack = `${String(id ?? '')} ${String(name ?? '')}`
  return FAMILIES.find((family) => family.match.test(haystack))
}

/**
 * @param id - the model id, e.g. `claude-sonnet-4`.
 * @param name - the display name, which sometimes carries what the id does not.
 * @returns the AppIcon glyph used when no brand mark exists.
 */
export function modelIcon (id, name) {
  const haystack = `${String(id ?? '')} ${String(name ?? '')}`
  return GLYPHS.find((glyph) => glyph.match.test(haystack))?.icon ?? 'cpu'
}

/**
 * @param id - the model id.
 * @param name - the display name.
 * @returns `{ svg, title }` for a brand mark, or undefined when the family has none.
 */
export function modelMark (id, name) {
  const family = familyOf(id, name)
  if (family === undefined) return undefined
  return { svg: artwork(family.svg), title: family.title }
}
