import { useEffect, useState } from 'react'
import { api } from './api'

export type Loaded<T> = { data: T | undefined; error: string | null; loading: boolean }

/** Loads `fn` whenever `deps` change; ignores answers that arrive after a newer request. */
export function useData<T>(fn: () => Promise<T>, deps: unknown[]): Loaded<T> {
  const [state, setState] = useState<Loaded<T>>({ data: undefined, error: null, loading: true })
  useEffect(() => {
    let live = true
    setState((s) => ({ ...s, loading: true, error: null }))
    fn().then(
      (data) => live && setState({ data, error: null, loading: false }),
      (e: unknown) => live && setState({ data: undefined, error: e instanceof Error ? e.message : String(e), loading: false }),
    )
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  return state
}

/**
 * The platform state ($EARN + the launch gate). While launching is closed it re-checks every 5 s, so a visitor
 * already on the page sees $EARN appear and launching open seconds after the launch watcher sets it. Stops once open.
 */
export function usePlatform() {
  const [tick, setTick] = useState(0)
  const platform = useData(() => api.platform(), [tick])
  const open = platform.data?.launchesOpen === true
  useEffect(() => {
    if (open) return
    const t = setInterval(() => setTick((n) => n + 1), 5000)
    return () => clearInterval(t)
  }, [open])
  return platform
}
