import React, { useEffect, useState } from 'react'
import { ActionIcon, Button as MantineButton, MantineProvider, createTheme, defaultVariantColorsResolver, type ButtonProps as MantineButtonProps, type CSSVariablesResolver } from '@mantine/core'
import { AlertCircle, ArrowLeft, Box, Check, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, CloudOff, Download, ExternalLink, File, FileUp, HardDrive, Image, Info, MessageSquare, Mic, MoreHorizontal, Plug, ScanEye, Search, Settings, Square, Star, Trash2, Volume2, X, type LucideIcon } from 'lucide-react'
import '@mantine/core/styles.css'

const icons: Record<string, LucideIcon> = {
  alert: AlertCircle, 'arrow-left': ArrowLeft, box: Box, check: Check, 'chevron-down': ChevronDown, 'chevron-left': ChevronLeft,
  'chevron-right': ChevronRight, 'chevron-up': ChevronUp, 'cloud-off': CloudOff, download: Download,
  'external-link': ExternalLink, file: File, 'file-up': FileUp, 'hard-drive': HardDrive, image: Image,
  info: Info, chat: MessageSquare, vision: ScanEye, mic: Mic, 'more-horizontal': MoreHorizontal, plug: Plug, 'scan-eye': ScanEye,
  search: Search, settings: Settings, star: Star, stop: Square, trash: Trash2, tts: Volume2, x: X,
}

export function Icon({ name, size = 16, className }: { name: string, size?: number, className?: string }) {
  const Component = icons[name] ?? Info
  return <Component size={size} strokeWidth={1.6} aria-hidden="true" className={className} />
}

export type ButtonProps = React.ComponentPropsWithRef<'button'> & {
  variant?: MantineButtonProps['variant']
  leftSection?: React.ReactNode
  rightSection?: React.ReactNode
  fullWidth?: boolean
  loading?: boolean
  appearance?: 'primary' | 'quiet' | 'danger'
  size?: MantineButtonProps['size'] | 'small'
  icon?: string
  iconOnly?: boolean
}

export function Button({ appearance, icon, iconOnly, size = 'xs', variant, title, children, ...props }: ButtonProps) {
  const resolvedVariant = variant ?? (appearance === 'primary' ? 'filled' : 'subtle')
  if (iconOnly) return <ActionIcon {...props} title={title} aria-label={props['aria-label'] ?? title} size={32} variant={resolvedVariant} color={appearance === 'danger' ? 'red' : undefined} data-appearance={appearance}><Icon name={icon ?? 'x'} /></ActionIcon>
  return <MantineButton {...props} title={title} size={size === 'small' ? 'xs' : size} variant={resolvedVariant} color={appearance === 'danger' ? 'red' : undefined} leftSection={icon ? <Icon name={icon} /> : props.leftSection} data-appearance={appearance}>{children}</MantineButton>
}

const theme = createTheme({
  fontFamily: 'var(--font-sans)', fontFamilyMonospace: 'var(--font-mono)',
  fontSizes: { xs: '12px', sm: '13px', md: '14px', lg: '16px', xl: '20px' },
  defaultRadius: 6,
  primaryColor: 'lexora',
  colors: { lexora: ['#f2f5f9', '#e3e9f1', '#cad5e4', '#aabdd3', '#879fbe', '#6b86aa', '#526e95', '#40597d', '#334868', '#293b56'] },
  respectReducedMotion: true,
  headings: { fontFamily: 'var(--font-sans)', fontWeight: '600' },
  components: {
    Button: MantineButton.extend({ defaultProps: { size: 'xs', fw: 500 } }),
    Badge: { defaultProps: { fz: '11px' } },
    Tabs: { defaultProps: { variant: 'pills' } },
  },
  variantColorResolver(input) {
    if (input.color === 'red' && input.variant === 'subtle') return { background: 'transparent', hover: 'var(--surface-2)', color: 'var(--danger)', border: 'transparent' }
    if (input.color === 'gray' && input.variant === 'light') return { background: 'var(--surface-3)', hover: 'var(--surface-3)', color: 'var(--text-secondary)', border: 'transparent' }
    if (input.color && !['lexora', 'gray'].includes(input.color)) return defaultVariantColorsResolver(input)
    if (input.variant === 'filled') return { background: 'var(--lexora-accent-solid, Highlight)', hover: 'var(--lexora-accent-hover, var(--lexora-accent-solid, Highlight))', color: 'var(--lexora-on-accent, white)', border: 'transparent' }
    if (input.variant === 'outline') return { background: 'transparent', hover: 'var(--surface-2)', color: 'var(--text-primary)', border: '1px solid var(--border)' }
    if (input.variant === 'light') return { background: 'var(--accent-soft)', hover: 'var(--surface-3)', color: 'var(--accent)', border: 'transparent' }
    if (input.variant === 'subtle') return { background: 'transparent', hover: 'var(--surface-2)', color: 'var(--text-primary)', border: 'transparent' }
    return defaultVariantColorsResolver(input)
  },
})

const hostColors = {
    '--mantine-color-body': 'var(--surface-base)', '--mantine-color-text': 'var(--text-primary)',
    '--mantine-color-dimmed': 'var(--text-secondary)', '--mantine-color-placeholder': 'var(--text-secondary)',
    '--mantine-color-default': 'var(--surface-base)', '--mantine-color-default-hover': 'var(--surface-2)',
    '--mantine-color-default-color': 'var(--text-primary)', '--mantine-color-default-border': 'var(--border)',
    '--mantine-primary-color-filled': 'var(--lexora-accent-solid, Highlight)',
    '--mantine-primary-color-light': 'var(--accent-soft)', '--mantine-primary-color-light-color': 'var(--accent)',
    '--mantine-color-error': 'var(--danger)', '--mantine-color-anchor': 'var(--accent)',
}
const variables: CSSVariablesResolver = () => ({ variables: {}, light: hostColors, dark: hostColors })

export function InterfaceProvider({ context, children }) {
  const [scheme, setScheme] = useState(context.environment.colorScheme)
  useEffect(() => {
    const subscription = context.onEnvironmentChange(environment => setScheme(environment.colorScheme))
    return () => subscription.dispose()
  }, [context])
  return <MantineProvider theme={theme} forceColorScheme={scheme} cssVariablesResolver={variables}>{children}</MantineProvider>
}
