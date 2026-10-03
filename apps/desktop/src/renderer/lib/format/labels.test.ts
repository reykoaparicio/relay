import { describe, expect, it } from 'vitest';
import { exclusionReasonText, secretLabelText, suspectedSecretText } from './labels';

describe('suspected-secret labels (E2 #11)', () => {
  it('maps every engine label to words, and anything else to "a credential"', () => {
    expect(secretLabelText('anthropic_key')).toBe('Anthropic API key');
    expect(secretLabelText('openai_key')).toBe('OpenAI API key');
    expect(secretLabelText('github_token')).toBe('GitHub token');
    expect(secretLabelText('google_api_key')).toBe('Google API key');
    expect(secretLabelText('aws_access_key')).toBe('AWS access key');
    expect(secretLabelText('private_key')).toBe('private key');
    expect(secretLabelText('bearer_token')).toBe('bearer token');
    expect(secretLabelText('credential_value')).toBe('credential value');
    expect(secretLabelText('something_new')).toBe('a credential');
    expect(secretLabelText('constructor')).toBe('a credential');
    expect(secretLabelText(undefined)).toBe('a credential');
  });

  it('words the flag with the line when known', () => {
    expect(suspectedSecretText('anthropic_key', 4)).toBe('Looks like it contains a secret: Anthropic API key, line 4');
    expect(suspectedSecretText(undefined, undefined)).toBe('Looks like it contains a secret: a credential');
  });
});

describe('exclusion reasons', () => {
  it('hard_link carries an explanation; other reasons are the label alone', () => {
    expect(exclusionReasonText('hard_link')).toBe(
      'Hard-linked file: has more than one hard link, so it may be a file from outside the project; never read',
    );
    expect(exclusionReasonText('secret')).toBe('Possible secret');
  });
});
