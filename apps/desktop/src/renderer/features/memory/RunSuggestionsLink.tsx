// Memory suggestions a run proposed (10 J8 completed inspector, J10 report): "n memory suggestions from this run ·
// Review suggestions", linked to the Memory page's Suggested tab. Data: the project's suggested records whose source is
// this run (`memory.list`, already cached by the Memory page and the Overview tile).
import { Link } from 'react-router';
import { useMemoryList } from '../../hooks/useMemoryList';
import { paths } from '../shell/paths';

export interface RunSuggestionsLinkProps {
  readonly projectId: string;
  readonly runId: string;
  /** Text when the run proposed none (default: nothing is rendered). */
  readonly emptyText?: string;
}

export function RunSuggestionsLink({ projectId, runId, emptyText }: RunSuggestionsLinkProps) {
  const suggested = useMemoryList(projectId, 'suggested');
  const fromRun = (suggested.data ?? []).filter((r) => r.source.kind === 'run' && r.source.runId === runId);
  if (fromRun.length === 0) return emptyText === undefined || suggested.data === undefined ? null : <p className="subtle">{emptyText}</p>;
  const one = fromRun.length === 1 ? fromRun[0] : undefined;
  return (
    <p className="small">
      {one === undefined ? `${String(fromRun.length)} memory suggestions` : '1 memory suggestion'} from this run
      {one === undefined ? null : (
        <>
          {' '}(<q>{one.title}</q>)
        </>
      )}{' '}
      {fromRun.length === 1 ? 'waits' : 'wait'} for your review; runs do not use suggestions until you approve them.{' '}
      <Link to={paths.memory(projectId, { tab: 'suggested', ...(one === undefined ? {} : { record: one.id }) })}>
        {one === undefined ? 'Review suggestions' : 'Review suggestion'}
      </Link>
    </p>
  );
}
