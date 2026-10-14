/**
 * YouTube video-ID extraction.
 *
 * Accepts every shape of YouTube reference a coach might paste:
 *  - Full watch URLs:  https://www.youtube.com/watch?v=VIDEO_ID
 *  - Short links:      https://youtu.be/VIDEO_ID
 *  - Live URLs:        https://www.youtube.com/live/VIDEO_ID
 *  - Embed URLs:       https://www.youtube.com/embed/VIDEO_ID
 *  - /v/ and /shorts/ URLs, Studio URLs (studio.youtube.com/video/VIDEO_ID/...)
 *  - A bare 11-character video ID
 *
 * Returns the 11-character ID, or null when the input is unusable.
 * Callers must treat null as a 400 (bad input), never a 500.
 */

const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

function candidateIsVideoId(value: string | null | undefined): string | null {
  if (!value) return null;
  // Strip any trailing query/fragment leftovers (e.g. "?feature=share").
  const clean = value.split(/[?&#]/)[0];
  return VIDEO_ID_PATTERN.test(clean) ? clean : null;
}

export function extractYouTubeVideoId(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed) return null;

  // Bare ID fast path.
  const bare = candidateIsVideoId(trimmed);
  if (bare) return bare;

  // Try to parse as a URL. Inputs without a scheme (e.g. "youtube.com/...").
  let url: URL;
  try {
    url = new URL(trimmed.startsWith('http') ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }

  const host = url.hostname.replace(/^www\./, '');
  const isYouTubeHost =
    host === 'youtube.com' ||
    host === 'youtu.be' ||
    host === 'youtube-nocookie.com' ||
    host === 'studio.youtube.com' ||
    host.endsWith('.youtube.com');
  if (!isYouTubeHost) return null;

  // watch?v=ID — the most common paste.
  const vParam = url.searchParams.get('v');
  const fromParam = candidateIsVideoId(vParam);
  if (fromParam) return fromParam;

  // Path-based formats: /live/ID, /embed/ID, /v/ID, /shorts/ID, /video/ID/...
  const segments = url.pathname.split('/').filter(Boolean);
  for (const segment of segments) {
    const fromPath = candidateIsVideoId(segment);
    if (fromPath) return fromPath;
  }

  return null;
}
