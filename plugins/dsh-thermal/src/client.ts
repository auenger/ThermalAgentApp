import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { SettingsLauncherOwnerProps } from '@deepseek-ai/dsh-client-ui-settings/client'
import { createElement, useEffect } from 'react'

export const inject = ['uiWorkspace', 'slots']

/** The desktop consumes only this App-owned, versioned navigation contract. */
export function apply(ctx: Context): void {
  try {
  let settings: (() => void) | undefined
  const api = {
    protocol: 1,
    openSession(sessionId: string) {
      if (!/^session-[0-9a-f-]{36}$/iu.test(sessionId)) throw new Error('Invalid session identity')
      ctx.uiWorkspace.openSession(sessionId as Parameters<typeof ctx.uiWorkspace.openSession>[0])
      return true
    },
    openSettings() {
      if (!settings) return false
      settings()
      return true
    },
  }
  ctx.effect(() => {
    Object.defineProperty(window, 'thermalDsh', { value: api, configurable: true })
    return () => { if (Reflect.get(window, 'thermalDsh') === api) Reflect.deleteProperty(window, 'thermalDsh') }
  }, 'thermal:desktop-navigation')
  // The official slot owns settings visibility. No DOM selectors or private React state.
  ctx.slots.inject('settings.launcher', () => ctx.slots.register({ name: 'settings.launcher', priority: -10 },
    function ThermalSettingsLauncher(props: SettingsLauncherOwnerProps) {
      useEffect(() => {
        settings = props.openSettings
        return () => { if (settings === props.openSettings) settings = undefined }
      }, [props.openSettings])
      return createElement('button', { type: 'button', onClick: props.openSettings, title: 'DSH 设置',
        'aria-label': 'DSH 设置', style: { margin: 8, padding: 8, cursor: 'pointer' } }, props.wide ? 'DSH 设置' : '⚙')
    }))
  } catch (error) { console.error('Thermal client initialization:', error); throw error }
}
