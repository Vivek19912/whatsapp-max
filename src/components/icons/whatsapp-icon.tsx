/**
 * The ONE shared WhatsApp brand icon for the entire WACRM UI.
 *
 * Geometry is the EXACT user-provided SVG path data (verbatim —
 * do not "clean up", re-export, or swap it for another WhatsApp
 * mark). The supplied artwork has a very wide viewBox
 * (1487.13 x 346) whose mark occupies the first ~346 x 346 area,
 * so this renders a cropped `0 0 346 346` viewBox: a rendering
 * crop only, path data untouched.
 *
 * Color is never hard-coded: both paths use `fill="currentColor"`
 * so surrounding UI (light/dark aware classes) controls the color.
 *
 * Accessibility:
 * - decorative (default): `aria-hidden="true"`, no label — use
 *   when adjacent visible text already names WhatsApp.
 * - meaningful: pass `label` (e.g. "WhatsApp") — rendered as
 *   `aria-label` with `role="img"`, never duplicated alongside
 *   identical visible text.
 */

import type { SVGProps } from 'react';

type WhatsappIconProps = {
  /** Square pixel size (width + height). Defaults to 16. */
  size?: number;
  className?: string;
  /**
   * Accessible name for standalone (icon-only) usage. Omit for
   * decorative usage next to visible "WhatsApp" text.
   */
  label?: string;
} & Omit<
  SVGProps<SVGSVGElement>,
  | 'children'
  | 'dangerouslySetInnerHTML'
  | 'width'
  | 'height'
  | 'viewBox'
  | 'aria-label'
  | 'role'
>;

export const WHATSAPP_ICON_VIEWBOX = '0 0 346 346';

export const WHATSAPP_ICON_BODY_PATH =
  'M173,0C77.45,0,0,77.45,0,173c0,31.43,8.38,60.91,23.04,86.31L0,346l89.87-21.25c24.67,13.54,53,21.25,83.13,21.25,95.55,0,173-77.45,173-173S268.55,0,173,0ZM173,315.01c-28.91,0-55.81-8.64-78.24-23.48l-53.1,13.52,14.89-50.75c-16.11-23.03-25.56-51.06-25.56-81.3,0-78.43,63.58-142.01,142.01-142.01s142.01,63.58,142.01,142.01-63.58,142.01-142.01,142.01Z';

export const WHATSAPP_ICON_HANDSET_PATH =
  'M213.54,195.84l41.86,19.73c1.92.91,3.15,2.85,2.98,4.97-.45,5.51-2.66,16.55-12.56,26.44-27.93,27.93-78.09-3.67-80.13-4.89-12.34-6.63-24.06-15.49-35.17-26.61-11.11-11.11-19.98-22.84-26.61-35.17-1.22-2.04-32.82-52.19-4.89-80.13,9.9-9.9,20.93-12.1,26.44-12.56,2.12-.17,4.07,1.06,4.97,2.98l19.73,41.86c.93,1.98.52,4.33-1.02,5.88l-14.71,14.71c-3.18,3.18-4.12,8.13-1.92,12.06,5.37,9.63,12.59,18.9,20.95,27.43,8.53,8.36,17.8,15.58,27.43,20.95,3.93,2.19,8.88,1.26,12.06-1.92l14.71-14.71c1.55-1.55,3.9-1.96,5.88-1.02Z';

export function WhatsappIcon({ size = 16, className, label, ...rest }: WhatsappIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox={WHATSAPP_ICON_VIEWBOX}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      focusable="false"
      data-icon="whatsapp-brand"
      className={className}
      {...rest}
      aria-hidden={label ? undefined : (rest['aria-hidden'] ?? true)}
      aria-label={label}
      role={label ? 'img' : undefined}
    >
      <path d={WHATSAPP_ICON_BODY_PATH} fill="currentColor" />
      <path d={WHATSAPP_ICON_HANDSET_PATH} fill="currentColor" />
    </svg>
  );
}
