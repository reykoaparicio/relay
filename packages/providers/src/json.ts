/** `JSON.parse(text)`, or `undefined` when `text` is not valid JSON (model output, provider error bodies). Never throws. */
export function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
