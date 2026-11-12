import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import { WorkspaceLeadLink } from './workspace-lead-link';

describe('WorkspaceLeadLink (shared Recordings + Calls deep link)', () => {
  it('points at the existing ?contact= deep-link flow in a new safe tab', () => {
    const html = renderToStaticMarkup(
      <WorkspaceLeadLink contactId="c-1" title="Akash">
        Akash
      </WorkspaceLeadLink>
    );
    expect(html).toContain('href="/workspace?contact=c-1"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noreferrer"');
    expect(html).toContain('title="Akash"');
    expect(html).toContain('>Akash</a>');
  });

  it('encodes contact ids instead of guessing by name or phone', () => {
    const html = renderToStaticMarkup(
      <WorkspaceLeadLink contactId="c 1&2">X</WorkspaceLeadLink>
    );
    expect(html).toContain('href="/workspace?contact=c%201%262"');
  });
});
