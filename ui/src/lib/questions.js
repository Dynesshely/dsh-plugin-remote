/**
 * The `ask_user_question` tool, as the transcript sees it.
 *
 * The tool's arguments carry the questions and its result carries the answers, so both the model's
 * request and the user's reply can be read straight out of the Session log. Pure helpers, so the
 * parsing is unit-testable without a DOM.
 */

/** Tool names that carry a user question. */
export const QUESTION_TOOLS = new Set(['ask_user_question', 'request_user_input'])

/**
 * Split the desktop's "(Recommended)" marker off an option label.
 * @param label - raw option label.
 * @returns `{ label, recommended }`.
 */
export function splitRecommended (label) {
  const text = String(label ?? '')
  const marker = /\s*[（(]\s*recommended\s*[)）]\s*$/iu
  if (!marker.test(text)) return { label: text, recommended: false }
  return { label: text.replace(marker, '').trim(), recommended: true }
}

/**
 * @param option - one option from a tool argument or a pending record.
 * @returns `{ label, description? }` with a plain label.
 */
function normalizeOption (option) {
  const { label, recommended } = splitRecommended(option?.label)
  return {
    label,
    recommended,
    ...(typeof option?.description === 'string' && option.description !== '' ? { description: option.description } : {}),
  }
}

/**
 * @param question - one question from a tool argument or a pending record.
 * @returns the normalized question.
 *
 * The tool schema uses `multi_select` while the Host's request (and therefore a pending record) uses
 * `multiSelect`, so both spellings are accepted.
 */
function normalizeQuestion (question) {
  return {
    id: String(question?.id ?? ''),
    question: String(question?.question ?? ''),
    ...(typeof question?.header === 'string' && question.header !== '' ? { header: question.header } : {}),
    ...(typeof question?.detail === 'string' && question.detail !== '' ? { detail: question.detail } : {}),
    multiSelect: question?.multiSelect === true || question?.multi_select === true,
    options: (Array.isArray(question?.options) ? question.options : []).map(normalizeOption),
  }
}

/**
 * Normalize a question batch from either source: tool arguments or a pending record.
 * @param questions - raw questions.
 * @returns normalized questions (labels without the "(Recommended)" marker).
 */
export function normalizeQuestions (questions) {
  return (Array.isArray(questions) ? questions : []).map(normalizeQuestion)
}

/**
 * Parse an `ask_user_question` call's arguments.
 * @param name - the tool name from the `tool/call` event.
 * @param args - the raw JSON argument string (or an already parsed object).
 * @returns the normalized questions, or `[]` when this is not a question call.
 */
export function parseQuestionArgs (name, args) {
  if (!QUESTION_TOOLS.has(String(name ?? ''))) return []
  let payload = args
  if (typeof args === 'string') {
    try {
      payload = JSON.parse(args)
    } catch {
      return []
    }
  }
  if (payload === null || typeof payload !== 'object') return []
  return normalizeQuestions(payload.questions).filter((question) => question.id !== '' || question.question !== '')
}

/**
 * Parse the answers out of an `ask_user_question` result.
 *
 * The tool replies with `{ answers: [{ id, selected, custom? }] }`, but a result may also arrive as
 * the bare array or embedded in surrounding text, so the first JSON payload in the text is used.
 * @param result - the tool result text.
 * @returns `{ id, selected, custom? }[]`, empty when nothing parses.
 */
export function parseQuestionResult (result) {
  const text = String(result ?? '').trim()
  if (text === '') return []
  const candidates = [text]
  const start = text.search(/[[{]/u)
  if (start > 0) candidates.push(text.slice(start))
  for (const candidate of candidates) {
    let payload
    try {
      payload = JSON.parse(candidate)
    } catch {
      continue
    }
    const answers = Array.isArray(payload) ? payload : payload?.answers
    if (!Array.isArray(answers)) continue
    return answers
      .filter((answer) => answer !== null && typeof answer === 'object')
      .map((answer) => ({
        id: String(answer.id ?? ''),
        selected: (Array.isArray(answer.selected) ? answer.selected : []).map((label) => String(label)),
        ...(typeof answer.custom === 'string' && answer.custom !== '' ? { custom: answer.custom } : {}),
      }))
  }
  return []
}

/**
 * The draft a question starts with.
 *
 * A marked first option is pre-selected, mirroring the Desktop's `recommendedFirstOption`: the marker
 * means "this is the recommended answer", not merely a label suffix. Only the first option counts.
 * @param question - a normalized question.
 * @returns `{ id, selected, custom }`.
 */
export function initialDraft (question) {
  const first = (question?.options ?? [])[0]
  return {
    id: String(question?.id ?? ''),
    selected: first?.recommended === true ? [first.label] : [],
    custom: '',
  }
}

/**
 * @param answers - parsed answers.
 * @param id - question id.
 * @returns the answer for that question, or undefined.
 */
export function answerOf (answers, id) {
  return (Array.isArray(answers) ? answers : []).find((answer) => answer.id === String(id))
}

/**
 * @param question - a normalized question.
 * @param answer - its answer, if any.
 * @returns whether the question has an answer (a picked option or custom text).
 */
export function isAnswered (question, answer) {
  if (answer === undefined) return false
  return answer.selected.length > 0 || (answer.custom ?? '') !== ''
}

/**
 * Whether every question in a batch was answered.
 * @param questions - normalized questions.
 * @param answers - parsed answers.
 * @returns true when the batch is complete.
 */
export function allAnswered (questions, answers) {
  return questions.length > 0 && questions.every((question) => isAnswered(question, answerOf(answers, question.id)))
}
