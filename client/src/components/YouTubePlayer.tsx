import { useEffect, useRef, useState } from 'react';

/**
 * Inline YouTube player with a hard load timeout.
 *
 * YouTube's IFrame API can hang forever (blocked script, unreachable API,
 * slow network) — so we give it 10 seconds: if the player never reports
 * ready, we destroy it and show a friendly error with a Retry button
 * instead of an endless spinner. The error wording differs for live
 * broadcasts vs recordings, because "still processing" only makes sense
 * for a recording.
 *
 * The "Open on YouTube" link is a secondary fallback only — viewers
 * should never have to leave the app to watch.
 */

declare global {
  interface Window {
    YT?: {
      Player: new (
        element: HTMLElement,
        options: {
          videoId: string;
          playerVars?: Record<string, number | string>;
          events?: {
            onReady?: () => void;
            onError?: (e: { data: number }) => void;
          };
        },
      ) => { destroy: () => void };
    };
    onYouTubeIframeAPIReady?: () => void;
  }
}

const LOAD_TIMEOUT_MS = 10_000;

let apiPromise: Promise<void> | null = null;

function loadYouTubeApi(): Promise<void> {
  if (typeof window === 'undefined') return Promise.reject(new Error('No window'));
  if (window.YT?.Player) return Promise.resolve();
  if (!apiPromise) {
    apiPromise = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        apiPromise = null; // Let a Retry attempt a fresh load.
        reject(new Error('YouTube API timed out'));
      }, LOAD_TIMEOUT_MS);
      window.onYouTubeIframeAPIReady = () => {
        clearTimeout(timeout);
        resolve();
      };
      const tag = document.createElement('script');
      tag.src = 'https://www.youtube.com/iframe_api';
      tag.onerror = () => {
        clearTimeout(timeout);
        apiPromise = null;
        reject(new Error('YouTube API failed to load'));
      };
      document.head.appendChild(tag);
    });
  }
  return apiPromise;
}

interface Props {
  videoId: string;
  isLive: boolean;
  /** Optional start offset (seconds) — Reel Studio preview jumps each
   *  clip to its timestamp via the player's `start` var. */
  startSeconds?: number;
}

export default function YouTubePlayer({ videoId, isLive, startSeconds }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<{ destroy: () => void } | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState('loading');

    // Second-level timeout: the API loaded but the player never fired ready.
    const timeout = setTimeout(() => {
      if (cancelled) return;
      playerRef.current?.destroy();
      playerRef.current = null;
      setState('error');
    }, LOAD_TIMEOUT_MS);

    loadYouTubeApi()
      .then(() => {
        if (cancelled || !containerRef.current || !window.YT) return;
        playerRef.current = new window.YT.Player(containerRef.current, {
          videoId,
          playerVars: { rel: 0, playsinline: 1, ...(startSeconds ? { start: startSeconds } : {}) },
          events: {
            onReady: () => {
              if (cancelled) return;
              clearTimeout(timeout);
              setState('ready');
            },
            onError: () => {
              if (cancelled) return;
              clearTimeout(timeout);
              setState('error');
            },
          },
        });
      })
      .catch(() => {
        if (cancelled) return;
        clearTimeout(timeout);
        setState('error');
      });

    return () => {
      cancelled = true;
      clearTimeout(timeout);
      playerRef.current?.destroy();
      playerRef.current = null;
    };
  }, [videoId, retryKey, startSeconds]);

  if (state === 'error') {
    return (
      <div className="yt-error">
        <strong>
          {isLive ? 'The live stream couldn’t play here.' : 'This recording couldn’t play here.'}
        </strong>
        <p>
          {isLive
            ? 'Check YouTube Studio: the stream must be Public or Unlisted and embedding must be allowed for this stream.'
            : 'The recording may still be processing on YouTube, or the video may not allow embedding — check YouTube Studio.'}
        </p>
        <button onClick={() => setRetryKey((k) => k + 1)}>Retry</button>{' '}
        <a href={`https://www.youtube.com/watch?v=${videoId}`} target="_blank" rel="noreferrer">
          Open on YouTube
        </a>
      </div>
    );
  }

  return (
    <div className="yt-wrap">
      {state === 'loading' && <div className="yt-loading">Loading video…</div>}
      {/* The player mounts into this div; it stays rendered while loading
          so the IFrame API has a target, and shows once ready. */}
      <div ref={containerRef} className="yt-player" />
    </div>
  );
}
