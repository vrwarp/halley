import type { ChangeCardDto } from '@halley/shared';
import { describe, expect, it } from 'vitest';
import { resolveVisualReviewRoutes } from './visual-diff.js';

function makeCard(overrides: Partial<ChangeCardDto> & { path: string }): ChangeCardDto {
  return {
    id: `card-${overrides.path}`,
    status: 'modified',
    title: overrides.path,
    summary: 'Updated',
    attribution: 'Editor',
    diff: '',
    included: true,
    ...overrides,
  };
}

describe('resolveVisualReviewRoutes', () => {
  it('maps sermon JSON edits to /sermons/<slug> and adds /sermons when index fields change', () => {
    const episodeOnly = [
      makeCard({
        path: 'src/content/sermons/romans.json',
        jsonFields: [{ field: 'episodes', before: '[]', after: '[{}]' }],
      }),
    ];
    expect(resolveVisualReviewRoutes(episodeOnly, '/')).toEqual(['/sermons/romans']);

    const withTitleChange = [
      makeCard({
        path: 'src/content/sermons/romans.json',
        jsonFields: [{ field: 'title', before: 'Old', after: 'New' }],
      }),
    ];
    expect(resolveVisualReviewRoutes(withTitleChange, '/')).toEqual(['/sermons/romans', '/sermons']);
  });

  it('prioritizes activeRoute + "/" for shared component/layout/image edits', () => {
    const sharedCards = [makeCard({ path: 'src/components/Header.astro' })];
    expect(resolveVisualReviewRoutes(sharedCards, '/im-new')).toEqual(['/im-new', '/']);
    expect(resolveVisualReviewRoutes(sharedCards, '/')).toEqual(['/']);

    const imageCards = [makeCard({ path: 'public/images/community/pic.webp', isImage: true })];
    expect(resolveVisualReviewRoutes(imageCards, '/youth')).toEqual(['/youth', '/']);
  });

  it('caps resolved routes at 4 and ignores dynamic template filenames', () => {
    const manyPages = [
      makeCard({ path: 'src/pages/a.astro' }),
      makeCard({ path: 'src/pages/b.astro' }),
      makeCard({ path: 'src/pages/c.astro' }),
      makeCard({ path: 'src/pages/d.astro' }),
      makeCard({ path: 'src/pages/e.astro' }),
    ];
    expect(resolveVisualReviewRoutes(manyPages, '/')).toEqual(['/a', '/b', '/c', '/d']);
  });
});
