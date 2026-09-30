import { describe, expect, it } from 'vitest';
import { OPERATION_LIST } from '../ipc/catalog.js';
import { renderApiDoc } from './render-api-doc.js';

describe('renderApiDoc', () => {
  const doc = renderApiDoc(OPERATION_LIST);

  it('starts with a markdown table header and documents every renderer op', () => {
    const lines = doc.split('\n');

    expect(lines[0]).toMatch(/^\| Channel \|/);
    expect(lines[1]).toMatch(/^\|---/);
    for (const d of OPERATION_LIST) expect(doc).toContain(`\`${d.channel}\``);
  });

  it('never mentions internal runner ops or realpaths', () => {
    expect(doc).not.toMatch(/recordCredentialRef|createFromRoot|exportTo|[Rr]ealpath/);
  });

  it('shows rate limits and idempotency requirements', () => {
    expect(doc).toContain('5 / refill 0.0833 per s');
    expect(doc).toMatch(/runs\.start` \| command \| runner \| required/);
    expect(doc).toContain('| default |');
  });
});
