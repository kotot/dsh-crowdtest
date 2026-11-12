declare module '@deepseek-ai/dsh-client-ui-primitives' {
  import type { ButtonHTMLAttributes, ComponentType, ReactNode } from 'react'
  export const Button: ComponentType<ButtonHTMLAttributes<HTMLButtonElement> & {
    variant: 'outline' | 'primary'; size: 'sm'; icon?: ReactNode
  }>
  export const IconRefreshOutlineRegular: ComponentType<{ size: number }>
  export const Tag: ComponentType<{ tone: 'info'; children: ReactNode }>
}
