import { describe, expect, it } from 'vitest';
import { isTransientPublishError, resolvePublishedSiteUrl } from './publish-helpers.js';

describe('resolvePublishedSiteUrl', () => {
  it('returns null when liveSiteUrl is empty or disabled', () => {
    expect(resolvePublishedSiteUrl(null, ['/events'])).toBeNull();
    expect(resolvePublishedSiteUrl(undefined, ['/events'])).toBeNull();
    expect(resolvePublishedSiteUrl('', ['/events'])).toBeNull();
    expect(resolvePublishedSiteUrl('   ', ['/events'])).toBeNull();
  });

  it('deep-links to the changed page when exactly 1 page route changed', () => {
    expect(
      resolvePublishedSiteUrl('https://vrwarp.github.io/thecrossing.website', ['/events']),
    ).toBe('https://vrwarp.github.io/thecrossing.website/events');
    expect(
      resolvePublishedSiteUrl('https://vrwarp.github.io/thecrossing.website/', ['events']),
    ).toBe('https://vrwarp.github.io/thecrossing.website/events');
    expect(
      resolvePublishedSiteUrl('https://vrwarp.github.io/thecrossing.website', ['/events', '/events']),
    ).toBe('https://vrwarp.github.io/thecrossing.website/events');
  });

  it('links to site root when the homepage, multiple pages, or no page routes changed', () => {
    expect(resolvePublishedSiteUrl('https://vrwarp.github.io/thecrossing.website', ['/'])).toBe(
      'https://vrwarp.github.io/thecrossing.website/',
    );
    expect(
      resolvePublishedSiteUrl('https://vrwarp.github.io/thecrossing.website', ['/events', '/give']),
    ).toBe('https://vrwarp.github.io/thecrossing.website/');
    expect(resolvePublishedSiteUrl('https://vrwarp.github.io/thecrossing.website', [])).toBe(
      'https://vrwarp.github.io/thecrossing.website/',
    );
  });
});

describe('isTransientPublishError', () => {
  it('returns true when retryable flag is set or message indicates a GitHub/network hiccup', () => {
    expect(isTransientPublishError(true, 'anything')).toBe(true);
    expect(
      isTransientPublishError(
        false,
        'GitHub had a temporary hiccup while publishing your changes. Your edits are safe — please try publishing again in a moment.',
      ),
    ).toBe(true);
    expect(
      isTransientPublishError(
        undefined,
        'GitHub API /repos/org/repo/commits/abc/check-runs?per_page=100&page=1 failed (500): ',
      ),
    ).toBe(true);
    expect(isTransientPublishError(undefined, 'Lost connection to the workspace while running publish checks')).toBe(
      true,
    );
  });

  it('returns false for regular code/check failures', () => {
    expect(isTransientPublishError(false, 'Checks failed: Type & Astro check')).toBe(false);
    expect(isTransientPublishError(undefined, 'GitHub checks failed: CI / verify (failure)')).toBe(false);
    expect(isTransientPublishError(undefined, null)).toBe(false);
  });
});
