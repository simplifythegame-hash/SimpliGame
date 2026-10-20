/**
 * Branded temp screen for a video slot.
 *
 * The video slot ALWAYS shows something: when no video is loaded, this
 * placeholder fills the exact 16:9 slot the player occupies, so the
 * layout never shifts and there is never a collapsed empty gap or a
 * bare text line. Same SG lettermark as the app logo (navy SG, no outline),
 * brand-gradient background, and the game/clip context.
 */
interface Props {
  /** e.g. "LLAMAS vs TBD" or the reel name. */
  title: string;
  /** e.g. "Live now" / "Clip 1 of 4". */
  subtitle?: string;
  /** e.g. "No video loaded yet" / "Waiting for stream" / "No clip video". */
  status: string;
}

export default function VideoPlaceholder({ title, subtitle, status }: Props) {
  return (
    <div className="video-placeholder" role="img" aria-label={`${title} — ${status}`}>
      <img className="video-placeholder-mark" src="/icon.svg?v=3" alt="" aria-hidden="true" />
      <div className="video-placeholder-title">{title}</div>
      {subtitle && <div className="video-placeholder-subtitle">{subtitle}</div>}
      <div className="video-placeholder-status">{status}</div>
    </div>
  );
}
