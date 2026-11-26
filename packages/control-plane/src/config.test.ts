import { describe, expect, it } from 'vitest';
import { deriveGitHubPagesUrl, resolveLiveSiteUrl } from './config.js';

describe('deriveGitHubPagesUrl', () => {
  it('derives https://<owner>.github.io/<repo> for project repositories', () => {
    expect(deriveGitHubPagesUrl('vrwarp/thecrossing.website')).toBe(
      'https://vrwarp.github.io/thecrossing.website',
    );
  });

  it('lowercases the owner hostname while preserving repository path case', () => {
    expect(deriveGitHubPagesUrl('MyOrg/MySite')).toBe('https://myorg.github.io/MySite');
  });

  it('omits the repo subpath for user/org root repositories (<owner>.github.io)', () => {
    expect(deriveGitHubPagesUrl('vrwarp/vrwarp.github.io')).toBe('https://vrwarp.github.io');
    expect(deriveGitHubPagesUrl('MyOrg/myorg.github.io')).toBe('https://myorg.github.io');
  });

  it('returns null for invalid repo strings', () => {
    expect(deriveGitHubPagesUrl('')).toBeNull();
    expect(deriveGitHubPagesUrl('only-one-part')).toBeNull();
    expect(deriveGitHubPagesUrl('a/b/c')).toBeNull();
  });
});

describe('resolveLiveSiteUrl', () => {
  it('derives the GitHub Pages URL from HALLEY_REPO by default (ignoring stale astro.config site)', () => {
    expect(
      resolveLiveSiteUrl(
        { repo: 'other-user/thecrossing.website', liveSiteUrl: '' },
        'https://vrwarp.github.io/thecrossing.website',
      ),
    ).toBe('https://other-user.github.io/thecrossing.website');
  });

  it('allows HALLEY_LIVE_SITE_URL to override the derived URL', () => {
    expect(
      resolveLiveSiteUrl(
        { repo: 'vrwarp/thecrossing.website', liveSiteUrl: 'https://thecrossing.church/' },
        'https://vrwarp.github.io/thecrossing.website',
      ),
    ).toBe('https://thecrossing.church');
  });

  it('returns null when HALLEY_LIVE_SITE_URL is "none" or "off"', () => {
    expect(
      resolveLiveSiteUrl(
        { repo: 'vrwarp/thecrossing.website', liveSiteUrl: 'none' },
        'https://vrwarp.github.io/thecrossing.website',
      ),
    ).toBeNull();
    expect(
      resolveLiveSiteUrl(
        { repo: 'vrwarp/thecrossing.website', liveSiteUrl: 'OFF' },
        'https://vrwarp.github.io/thecrossing.website',
      ),
    ).toBeNull();
  });

  it('falls back to detectedSiteUrl if HALLEY_REPO is not owner/repo', () => {
    expect(
      resolveLiveSiteUrl({ repo: '', liveSiteUrl: '' }, 'https://example.org/site/'),
    ).toBe('https://example.org/site');
  });
});
