import React from 'react'

export function Button({ variant, size, icon, children, ...props }) {
  return <button data-variant={variant} data-size={size} {...props}>{icon}{children}</button>
}
export function IconRefreshOutlineRegular({ size }) {
  return <i data-icon="refresh" data-size={size} />
}
export function Tag({ tone, children }) {
  return <span data-tone={tone}>{children}</span>
}
