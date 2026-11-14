import type { ReactNode } from 'react'

/** Small inline icons, drawn on a 24 px grid with a 2 px stroke. */
function Icon({ children, filled = false }: { children: ReactNode; filled?: boolean }) {
  return (
    <svg
      className="icon"
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke={filled ? 'none' : 'currentColor'}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

/** The product mark: a pulse line. */
export const PulseIcon = () => (
  <Icon>
    <path d="M3 12h4l2.5-6 4 12 2.5-6H21" />
  </Icon>
)

export const PlayIcon = () => (
  <Icon filled>
    <path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5Z" />
  </Icon>
)

export const PauseIcon = () => (
  <Icon filled>
    <rect x="6" y="5" width="4.5" height="14" rx="1.2" />
    <rect x="13.5" y="5" width="4.5" height="14" rx="1.2" />
  </Icon>
)

export const StopIcon = () => (
  <Icon filled>
    <rect x="6" y="6" width="12" height="12" rx="2.5" />
  </Icon>
)

export const MicIcon = () => (
  <Icon>
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3" />
  </Icon>
)

export const MicOffIcon = () => (
  <Icon>
    <path d="M9 9v2a3 3 0 0 0 5 2.2M15 9.5V6a3 3 0 0 0-5.7-1.3" />
    <path d="M5.5 11.5a6.5 6.5 0 0 0 10.6 5M18.5 11.5a6.5 6.5 0 0 1-.4 2.2M12 18v3M4 4l16 16" />
  </Icon>
)

export const PhoneOffIcon = () => (
  <Icon>
    <path d="M3.5 14.5c-.7-2 0-3.300 1.800-4.100 4.300-1.900 9.100-1.900 13.400 0 1.800.8 2.500 2.100 1.800 4.100l-.3.800a1 1 0 0 1-1.200.6l-3.200-.9a1 1 0 0 1-.7-.9l-.1-1.700a10 10 0 0 0-6 0l-.1 1.700a1 1 0 0 1-.7.9l-3.200.9a1 1 0 0 1-1.200-.6Z" />
  </Icon>
)

export const ArrowLeftIcon = () => (
  <Icon>
    <path d="M15 5l-7 7 7 7" />
  </Icon>
)

export const ArrowRightIcon = () => (
  <Icon>
    <path d="M9 5l7 7-7 7" />
  </Icon>
)

export const CheckIcon = () => (
  <Icon>
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </Icon>
)
