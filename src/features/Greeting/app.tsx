import { ToastProvider } from '@rentnerkev/toasts'
import { createRoot } from 'react-dom/client'

import { maxGreetingLength } from '@/lib/greeting.ts'

import { useGreetingLogic } from './Hooks/useGreetingLogic.ts'

function Greeting() {
    const { state, handler, setter } = useGreetingLogic()
    const { labels } = state
    return (
        <main>
            <h1>{labels.app}</h1>
            <nav aria-label={labels.app}>
                <button
                    aria-current={state.route === 'overview' ? 'page' : undefined}
                    disabled={!state.ready}
                    type="button"
                    onClick={() => handler.navigate('overview')}
                >
                    {labels.overview}
                </button>
                <button
                    aria-current={state.route === 'details' ? 'page' : undefined}
                    disabled={!state.ready}
                    type="button"
                    onClick={() => handler.navigate('details')}
                >
                    {labels.details}
                </button>
            </nav>
            {state.route === 'details' ? (
                <p>{labels.detailsText}</p>
            ) : (
                <section className="greeting-editor" aria-label={labels.app} aria-busy={state.busy}>
                    <p className="greeting">{state.greeting}</p>
                    <label htmlFor="greeting">{labels.field}</label>
                    <input
                        id="greeting"
                        disabled={!state.editable}
                        value={state.draft}
                        maxLength={maxGreetingLength * 2}
                        onChange={(event) => setter.setDraft(event.currentTarget.value)}
                        onKeyDown={(event) => {
                            if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                                void handler.handleSave()
                            }
                        }}
                    />
                    <button
                        disabled={state.disabled}
                        type="button"
                        onClick={() => void handler.handleSave()}
                    >
                        {labels.save}
                    </button>
                    <output>
                        {state.busy ? labels.busy : state.waiting ? labels.waiting : ''}
                    </output>
                </section>
            )}
            <ToastProvider locale={state.language} position="bottom-right">
                {null}
            </ToastProvider>
        </main>
    )
}

const container = document.getElementById('root')
if (!container) throw new Error('Greeting mount is missing')
createRoot(container).render(<Greeting />)
