import { createContext } from 'react'

export const AuthCtx = createContext(null)
export const JobsCtx = createContext(null)
export const SearchCtx = createContext({ query: '', set: () => {} })
export const ConsoleCtx = createContext(null)
export const CastCtx = createContext(null)
