import { useLayoutEffect, useState, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { App, ConfigProvider, theme, type ThemeConfig } from 'antd'
import zhCN from 'antd/locale/zh_CN'

export function OfficeTheme({ host, children }: { host: HTMLElement; children: ReactNode }) {
  const [config, setConfig] = useState<ThemeConfig>({})
  useLayoutEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)')
    let transitionFrame = 0
    const update = () => {
      cancelAnimationFrame(transitionFrame)
      host.dataset.themeUpdating = ''
      const css = getComputedStyle(host)
      const color = (name: string) => css.getPropertyValue(name).trim()
      const probe = document.createElement('span')
      probe.style.color = color('--o-bg'); host.append(probe)
      const rgb = getComputedStyle(probe).color.match(/[\d.]+/g)?.map(Number)
      probe.remove()
      const dark = rgb ? rgb[0] * .299 + rgb[1] * .587 + rgb[2] * .114 < 128 : media.matches
      setConfig({ algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm, token: {
        colorPrimary: color('--o-accent'), colorBgContainer: color('--o-bg'), colorBgElevated: color('--o-bg'),
        colorBgLayout: color('--o-subtle'), colorText: color('--o-fg'), colorTextSecondary: color('--o-muted'), colorBorder: color('--o-border'),
        colorError: color('--o-danger'), fontFamily: css.fontFamily, fontSize: 14, borderRadius: 7, controlHeight: 34,
        motion: !matchMedia('(prefers-reduced-motion: reduce)').matches,
      }, components: { Button: { primaryShadow: 'none', defaultShadow: 'none' }, Table: { headerBg: color('--o-bg'), cellPaddingBlock: 12 }, Modal: { titleFontSize: 18 } } })
      transitionFrame = requestAnimationFrame(() => { transitionFrame = requestAnimationFrame(() => { delete host.dataset.themeUpdating }) })
    }
    update()
    const observer = new MutationObserver(() => flushSync(update))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class', 'data-theme'] })
    observer.observe(document.body, { attributes: true, attributeFilter: ['style', 'class', 'data-theme'] })
    media.addEventListener('change', update)
    return () => { observer.disconnect(); media.removeEventListener('change', update); cancelAnimationFrame(transitionFrame); delete host.dataset.themeUpdating }
  }, [host])
  return <ConfigProvider button={{ autoInsertSpace: false }} locale={zhCN} theme={config} getPopupContainer={() => host}><App className="office-react-app" message={{ getContainer: () => host }}>{children}</App></ConfigProvider>
}
