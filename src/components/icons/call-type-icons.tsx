/**
 * Carrier call-type icon as a tiny inline SVG (no new icon
 * dependency — the repo ships only lucide-react).
 *
 * - `PhoneHandsetIcon`: a classic telephone receiver for carrier
 *   calls, visually distinct from generic chat icons.
 *
 * WhatsApp has exactly ONE source — `WhatsappIcon` in
 * `./whatsapp-icon` (exact user-provided geometry). Do not add a
 * second WhatsApp mark here.
 *
 * The phone icon is decorative (`aria-hidden`): the adjacent text
 * label (Phone) stays the accessible name. Sized ~14px via
 * className by callers; `fill="currentColor"` so it inherits the
 * semantic text color.
 */

type IconProps = {
  className?: string;
};

export function PhoneHandsetIcon({ className }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
      data-icon="phone-handset"
      className={className}
    >
      <path d="M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z" />
    </svg>
  );
}
