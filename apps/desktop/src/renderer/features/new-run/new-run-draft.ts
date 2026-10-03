// Per-project session draft of the New run form (module-level: it survives in-app navigation, e.g. a trip to Settings
// to raise the monthly allowance, and is gone when the app reloads). Cleared once the run starts.
import { INITIAL_FORM } from './new-run-model';
import type { NewRunForm } from './new-run-model';

const drafts = new Map<string, NewRunForm>();

/** The saved draft of a project's form, if any (never with the "submitted" flag: errors show again only on submit). */
export function loadNewRunDraft(projectId: string): NewRunForm | undefined {
  return drafts.get(projectId);
}

/** Saves the form as the project's draft; an untouched form removes it. */
export function saveNewRunDraft(projectId: string, form: NewRunForm): void {
  const draft = { ...form, submitted: false };
  const untouched = (Object.keys(INITIAL_FORM) as Array<keyof NewRunForm>).every((k) => draft[k] === INITIAL_FORM[k]);
  if (untouched) drafts.delete(projectId);
  else drafts.set(projectId, draft);
}

export function clearNewRunDraft(projectId: string): void {
  drafts.delete(projectId);
}

/** Test isolation: every rendered app starts without drafts. */
export function resetNewRunDrafts(): void {
  drafts.clear();
}
