import { createContext } from 'react'

export const AuthCtx = createContext(null)
export const JobsCtx = createContext(null)
export const SearchCtx = createContext({ query: '', set: () => {} })
