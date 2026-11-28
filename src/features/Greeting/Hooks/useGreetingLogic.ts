import { toast } from '@rentnerkev/toasts'
import { useEffect, useEffectEvent, useRef, useState } from 'react'

import { maxGreetingLength, readGreeting } from '@/lib/greeting.ts'

import { connectGreetingBridge, sessionKey, type Context } from '../bridge.ts'

const copy = {
    en: {
        app: 'Greeting',
        details: 'Details',
        overview: 'Overview',
        field: 'New greeting',
        save: 'Save greeting',
        waiting: 'Waiting for the app…',
        busy: 'Saving…',
        successTitle: 'Greeting saved',
        successContent: 'The new greeting will be here after a restart.',
        errorTitle: 'Greeting unavailable',
        loadError: 'Reload the app to try reading the greeting again.',
        saveError: 'Try saving again when the app is ready.',
        detailsText: 'Your greeting is stored in this app installation.',
    },
    de: {
        app: 'Gruß',
        details: 'Details',
        overview: 'Übersicht',
        field: 'Neuer Gruß',
        save: 'Gruß speichern',
        waiting: 'Die App wird vorbereitet…',
        busy: 'Wird gespeichert…',
        successTitle: 'Gruß gespeichert',
        successContent: 'Dein neuer Gruß ist auch nach einem Neustart verfügbar.',
        errorTitle: 'Gruß nicht verfügbar',
        loadError: 'Lade die App neu, um den Gruß erneut zu lesen.',
        saveError: 'Versuche es erneut, sobald die App bereit ist.',
        detailsText: 'Dein Gruß wird in dieser App-Installation gespeichert.',
    },
}

interface GreetingForm {
    binding: string
    greeting: string
    draft: string
}

export function useGreetingLogic() {
    const bridge = useRef<ReturnType<typeof connectGreetingBridge> | null>(null)
    const pending = useRef<string | undefined>(undefined)
    const latestSave = useRef<{ binding: string } | undefined>(undefined)
    const [context, setContext] = useState<Context>()
    const [form, setForm] = useState<GreetingForm>()
    const [savingBinding, setSavingBinding] = useState<string>()
    const [failedBinding, setFailedBinding] = useState<string>()
    const binding = context ? sessionKey(context) : undefined
    const ready = context?.ready ?? false
    const language = /^de(?:-|$)/iu.test(context?.locale ?? '') ? ('de' as const) : ('en' as const)
    const labels = copy[language]
    const reportLoadError = useEffectEvent(() => {
        toast.error(labels.loadError, { title: labels.errorTitle })
    })

    useEffect(() => {
        const channel = connectGreetingBridge(setContext)
        bridge.current = channel
        return () => {
            bridge.current = null
            channel.close()
        }
    }, [])

    useEffect(() => {
        // The language of the rendered copy, not the host locale, which only formats values.
        document.documentElement.lang = language
        document.documentElement.dataset.theme = context?.theme ?? 'light'
    }, [language, context?.theme])

    useEffect(() => {
        const channel = bridge.current
        if (!ready || binding === undefined || !channel || pending.current === binding) return

        const saveAtStart = latestSave.current
        let active = true
        const canApply = () =>
            active &&
            channel.isCurrent(binding) &&
            (latestSave.current === saveAtStart || latestSave.current?.binding !== binding)
        void channel.greeting(binding, 'get-greeting', {}).then(
            (greeting) => {
                if (canApply()) {
                    setForm({ binding, greeting, draft: greeting })
                }
            },
            () => {
                if (canApply()) {
                    setFailedBinding(binding)
                    reportLoadError()
                }
            },
        )
        return () => {
            active = false
        }
    }, [ready, binding])

    const current = form?.binding === binding ? form : undefined
    const busy = binding !== undefined && savingBinding === binding
    const editable = ready && current !== undefined && !busy
    const next = readGreeting({ greeting: current?.draft.trim() })
    const disabled = !editable || next === undefined || next === current?.greeting

    async function handleSave() {
        const channel = bridge.current
        if (!channel || disabled || next === undefined || !binding || pending.current === binding) {
            return
        }
        pending.current = binding
        latestSave.current = { binding }
        setSavingBinding(binding)
        try {
            if (!(await channel.confirmSave(binding))) return
            const greeting = await channel.greeting(binding, 'save-greeting', { greeting: next })
            if (channel.isCurrent(binding)) {
                setForm({ binding, greeting, draft: greeting })
                toast.success(labels.successContent, { title: labels.successTitle })
            }
        } catch {
            if (channel.isCurrent(binding)) {
                toast.error(labels.saveError, { title: labels.errorTitle })
            }
        } finally {
            if (pending.current === binding) {
                pending.current = undefined
                setSavingBinding(undefined)
            }
        }
    }

    return {
        state: {
            greeting: current?.greeting ?? '',
            draft: current?.draft ?? '',
            busy,
            waiting: !editable && (binding === undefined || failedBinding !== binding),
            ready,
            editable,
            disabled,
            language,
            labels,
            route: context?.route,
        },
        handler: {
            handleSave,
            navigate: (route: 'overview' | 'details') => bridge.current?.navigate(route),
        },
        setter: {
            setDraft: (draft: string) => {
                const limited = Array.from(draft).slice(0, maxGreetingLength).join('')
                setForm((entry) =>
                    entry?.binding === binding && entry ? { ...entry, draft: limited } : entry,
                )
            },
        },
    }
}
