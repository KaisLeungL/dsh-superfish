/** 稳定 ACP 实例的 Provider 管理页；所有写入仍走原生设置控制器。 */
import { createElement as h, useEffect, useId, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  Button,
  IconChevronRightOutlineMedium,
  IconCodeOutlineMedium,
  IconPlusOutlineMedium,
  IconRefreshOutlineMedium,
  IconSettingsOutlineMedium,
  IconTrashOutlineMedium,
  Input,
  Modal,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { catalogIdOf } from '../../contract/agent-config.ts'
import { ACP_CATALOG_ENTRIES, catalogEntryOf } from '../data/catalog.ts'
import {
  agentLoginHint,
  draftFromAgent,
  dropMaskedEnvKey,
  emptyDraft,
  healthRowOf,
  newProviderDraft,
  sortedAgentIds,
  validateAgentDraft,
} from '../data/logic.ts'
import type { AcpAgentConfig, AcpProviderHealth, AgentDraft, DraftError } from '../data/logic.ts'
import type { AcpSectionWire, AcpTranslate, UsePanelStore } from './AcpSection.ts'
import { localizedDiagnostic } from '../data/diagnostics.ts'
import css from './ProviderManagement.module.css'
import { ManagedChatGptCard } from './ManagedChatGptCard.ts'
import { ProviderMenu, ProviderModels } from './ProviderModels.ts'

type Props = { t: AcpTranslate; useStore: UsePanelStore; panel: AcpSectionWire }
type EditorProps = { t: AcpTranslate; draft: AgentDraft; edit(patch: Partial<AgentDraft>): void; disabled: boolean }

function status(t: AcpTranslate, config: AcpAgentConfig, health: AcpProviderHealth | undefined): string {
  if (config.enabled === false) return t('providerDisabled')
  if (config.authentication === 'chatgpt-managed' && !config.authBinding) return t('managedAuthDisconnected')
  if (health?.probe.status === 'ok') return t('providerCheckPassed')
  if (health?.probe.status === 'error' && health.probe.failureKind === 'auth_required')
    return t('providerSignInRequired')
  if (health?.probe.status === 'error') return t('providerProtocolError')
  return t('providerNotChecked')
}

export function ProviderManagement({ t, useStore, panel }: Props): ReactNode {
  const snapshot = useStore((value) => value)
  const [selected, setSelected] = useState('')
  const [adding, setAdding] = useState(false)
  const [query, setQuery] = useState('')
  const [pending, setPending] = useState<string | undefined>(undefined)
  const [failure, setFailure] = useState(false)
  const addRef = useRef<HTMLButtonElement | null>(null)
  useEffect(() => {
    panel.refreshHealth()
  }, [panel])
  const settings = snapshot.settings
  if (settings.status !== 'ready')
    return h(
      'p',
      { className: css.empty },
      t(
        settings.status === 'loading'
          ? 'settingsLoading'
          : settings.status === 'invalid'
            ? 'settingsInvalid'
            : 'settingsUnavailable',
      ),
    )
  const agents = settings.agents
  const ids = sortedAgentIds(agents)
  const id = agents[selected] === undefined ? ids[0] : selected
  const config = id === undefined ? undefined : agents[id]
  const readOnly = !settings.writable
  const closeAdd = (): void => {
    setAdding(false)
    addRef.current?.focus()
  }
  const toggle = async (agentId: string): Promise<void> => {
    const current = agents[agentId]
    if (current === undefined) return
    setPending(agentId)
    setFailure(false)
    try {
      const draft = { ...draftFromAgent(agentId, current), enabled: current.enabled === false }
      setFailure((await panel.saveAgent(agentId, draft)) !== undefined)
    } catch {
      setFailure(true)
    } finally {
      setPending(undefined)
    }
  }
  const filtered = ids.filter((key) =>
    `${key} ${agents[key]?.name}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
  )
  return h(
    'div',
    { className: css.root, 'data-dsh-acp-panel': '', 'data-dsh-acp-management': '' },
    h(
      'div',
      { className: css.layout, 'data-adding': adding || undefined },
      h(
        'aside',
        { className: css.sidebar, 'aria-label': t('providerInstances') },
        h(
          'header',
          { className: css.sidebarHeader },
          h('h3', null, t('providerInstances')),
          h(
            'div',
            { className: css.sidebarActions },
            h(
              Button,
              {
                ref: addRef,
                variant: 'outline',
                size: 'sm',
                icon: h(IconPlusOutlineMedium, { size: 14 }),
                'aria-label': t('providerAdd'),
                disabled: readOnly || adding,
                onClick: () => setAdding(true),
              },
              t('providerAddShort'),
            ),
            h(ProviderMenu, {
              label: t('providerListActions'),
              items: [
                {
                  id: 'check',
                  label: t('providerCheckAll'),
                  icon: h(IconRefreshOutlineMedium, { size: 16 }),
                  disabled: snapshot.health.status === 'loading' || snapshot.health.checkingAgentIds.length > 0,
                },
              ],
              onSelect: () => panel.refreshHealth(true),
            }),
          ),
        ),
        readOnly ? h('p', { role: 'status' }, t('readOnly')) : null,
        failure ? h('p', { className: css.error, role: 'alert' }, t('providerToggleFailed')) : null,
        snapshot.health.status === 'unreachable'
          ? h('p', { className: css.error, role: 'status' }, t('healthUnreachable'))
          : null,
        h(Input, {
          type: 'search',
          value: query,
          'aria-label': t('providerSearch'),
          placeholder: t('providerSearch'),
          onChange: (event: { target: { value: string } }) => setQuery(event.target.value),
        }),
        h(
          'ul',
          { className: css.list },
          ...filtered.map((key) => {
            const current = agents[key]!
            return h(
              'li',
              {
                key,
                className: `${css.row} ${!adding && key === id ? css.selected : ''}`,
                'data-provider-instance': key,
              },
              h(
                'button',
                {
                  type: 'button',
                  className: css.select,
                  'aria-current': !adding && key === id ? 'true' : undefined,
                  onClick: () => {
                    setSelected(key)
                    setAdding(false)
                  },
                },
                h(ProviderMark, { id: key, config: current }),
                h(
                  'span',
                  { className: css.instanceText },
                  h('strong', null, current.name),
                  h(
                    'span',
                    { className: css.hint },
                    t(current.enabled === false ? 'providerDisabled' : 'providerEnabledState'),
                  ),
                ),
                !adding && key === id
                  ? h(IconChevronRightOutlineMedium, { size: 14, className: css.selectedChevron })
                  : null,
              ),
            )
          }),
        ),
        filtered.length === 0
          ? h('p', { className: css.empty }, t(ids.length === 0 ? 'providerNone' : 'providerNoMatch'))
          : null,
      ),
      adding
        ? h(AddProvider, {
            t,
            agents,
            panel,
            readOnly,
            checking: snapshot.health.status === 'loading' || snapshot.health.checkingAgentIds.length > 0,
            onCancel: closeAdd,
            onSaved: (savedId: string) => {
              setSelected(savedId)
              setAdding(false)
            },
          })
        : id !== undefined && config !== undefined
          ? h(ProviderDetail, {
              key: JSON.stringify(draftFromAgent(id, config)),
              t,
              id,
              config,
              agents,
              readOnly: readOnly || pending !== undefined,
              panel,
              health: healthRowOf(snapshot.health.rows, id),
              checking: snapshot.health.status === 'loading' || snapshot.health.checkingAgentIds.includes(id),
              checkError: snapshot.health.agentErrors[id],
              onToggle: () => void toggle(id),
              onDeleted: () => setSelected(''),
            })
          : h('div', { className: css.empty }, t('providerSelect')),
    ),
    h(
      'details',
      { className: css.preferences },
      h('summary', null, t('providerApproval')),
      h('p', { className: css.hint }, t('providerApprovalHint')),
      h(
        'select',
        {
          value: settings.toolApprovalDefault,
          disabled: readOnly || pending !== undefined,
          'aria-label': t('providerApproval'),
          onChange: async (event: { target: { value: string } }) => {
            const policy = event.target.value
            if (policy !== 'auto' && policy !== 'ask') return
            setPending('approval')
            setFailure(false)
            try {
              setFailure((await panel.setToolApprovalDefault(policy)) !== undefined)
            } catch {
              setFailure(true)
            } finally {
              setPending(undefined)
            }
          },
        },
        h('option', { value: 'auto' }, t('toolApprovalAuto')),
        h('option', { value: 'ask' }, t('toolApprovalAsk')),
      ),
    ),
  )
}

function ProviderMark({ id, config }: { id: string; config: AcpAgentConfig }): ReactNode {
  const codex = catalogIdOf(id, config) === 'codex-acp'
  return h(
    'span',
    { className: css.mark, 'aria-hidden': true },
    codex ? h(IconCodeOutlineMedium, { size: 18 }) : Array.from(config.name)[0]?.toLocaleUpperCase(),
  )
}

function Field({
  label,
  value,
  onChange,
  disabled,
  hint,
  error,
  multiline = false,
}: {
  label: string
  value: string
  onChange(value: string): void
  disabled: boolean
  hint?: string | undefined
  error?: string | undefined
  multiline?: boolean
}): ReactNode {
  const id = `provider-field-${useId()}`
  return h(
    'div',
    { className: css.field },
    h('label', { htmlFor: id }, label),
    multiline
      ? h('textarea', {
          id,
          value,
          disabled,
          'aria-describedby': hint || error ? `${id}-help` : undefined,
          rows: 3,
          'aria-invalid': error !== undefined,
          onChange: (event: { target: { value: string } }) => onChange(event.target.value),
        })
      : h(Input, {
          id,
          value,
          disabled,
          'aria-describedby': hint || error ? `${id}-help` : undefined,
          type: 'text',
          'aria-invalid': error !== undefined,
          onChange: (event: { target: { value: string } }) => onChange(event.target.value),
        }),
    error !== undefined
      ? h('span', { id: `${id}-help`, className: css.error, role: 'alert' }, error)
      : hint
        ? h('span', { id: `${id}-help`, className: css.hint }, hint)
        : null,
  )
}

function RuntimeFields({ t, draft, edit, disabled, open }: EditorProps & { open: boolean }): ReactNode {
  return h(
    'details',
    { className: css.group, open },
    h(
      'summary',
      null,
      t('providerRuntime'),
      h('span', { className: css.hint }, draft.command.split(/[\\/]/).at(-1) || t('providerRuntimeHint')),
    ),
    h(
      'div',
      { className: css.fields },
      h(Field, {
        label: t('fieldCommand'),
        value: draft.command,
        disabled,
        hint: t('fieldCommandHint'),
        onChange: (command: string) => edit({ command }),
      }),
      h(Field, {
        label: t('fieldArgs'),
        value: draft.argsText,
        disabled,
        multiline: true,
        hint: t('fieldArgsHint'),
        onChange: (argsText: string) => edit({ argsText }),
      }),
    ),
  )
}

function EnvironmentFields({ t, draft, edit, disabled }: EditorProps): ReactNode {
  const masked = Object.keys(draft.maskedEnv ?? {})
  return h(
    'section',
    { className: css.group },
    h('h3', null, t('providerEnvironment')),
    h('p', { className: css.hint }, t('providerSharedAuth')),
    h(Field, {
      label: t('fieldEnv'),
      value: draft.envText,
      disabled,
      multiline: true,
      hint: t('providerEnvHelp'),
      onChange: (envText: string) => edit({ envText }),
    }),
    masked.length > 0
      ? h(
          'ul',
          { className: css.masked },
          ...masked.map((key) =>
            h(
              'li',
              { key },
              h('code', null, key),
              h('span', { className: css.hint }, t('providerConfigured')),
              h(
                Button,
                {
                  variant: 'ghost',
                  size: 'sm',
                  disabled,
                  onClick: () => edit({ maskedEnv: dropMaskedEnvKey(draft, key).maskedEnv ?? {} }),
                },
                t('envMaskedRemove'),
              ),
            ),
          ),
        )
      : null,
  )
}

function ProviderDetail({
  t,
  id,
  config,
  agents,
  readOnly,
  panel,
  health,
  checking,
  checkError,
  onToggle,
  onDeleted,
}: {
  t: AcpTranslate
  id: string
  config: AcpAgentConfig
  agents: Record<string, AcpAgentConfig>
  readOnly: boolean
  panel: AcpSectionWire
  health: AcpProviderHealth | undefined
  checking: boolean
  checkError: string | undefined
  onToggle(): void
  onDeleted(): void
}): ReactNode {
  const [draft, setDraft] = useState(() => draftFromAgent(id, config))
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const [saved, setSaved] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [showHidden, setShowHidden] = useState(false)
  const connection = useRef<HTMLDetailsElement>(null)
  const advanced = useRef<HTMLDetailsElement>(null)
  const [count, setCount] = useState<number | undefined>(undefined)
  useEffect(() => {
    if (!confirming) return
    let active = true
    void panel
      .countBoundSessions(id)
      .then((value) => {
        if (active) setCount(value)
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [confirming, id, panel])
  const validation = validateAgentDraft(draft, agents, id)
  const dirty = JSON.stringify(draft) !== JSON.stringify(draftFromAgent(id, config))
  const disabled = readOnly || busy
  const edit = (patch: Partial<AgentDraft>): void => {
    setDraft((previous) => ({ ...previous, ...patch }))
    setFailure(undefined)
    setSaved(false)
  }
  const error = (value: DraftError | undefined): string | undefined =>
    value === undefined ? undefined : t(value.key, value.params)
  const save = async (): Promise<void> => {
    if (validation.config === undefined) return
    setBusy(true)
    setFailure(undefined)
    try {
      if ((await panel.saveAgent(id, draft)) !== undefined) {
        setFailure(t('providerSaveFailed'))
        return
      }
      setSaved(true)
      panel.notifyOutcome?.('saved')
      panel.refreshHealth()
    } catch {
      setFailure(t('providerSaveFailed'))
    } finally {
      setBusy(false)
    }
  }
  const remove = async (): Promise<void> => {
    setBusy(true)
    setFailure(undefined)
    try {
      if (config.authentication === 'chatgpt-managed') {
        if (!panel.managedChatGpt) throw new Error('托管授权服务不可用。')
        await panel.managedChatGpt.logout(id)
      }
      if ((await panel.deleteAgent(id)) !== undefined) {
        setFailure(t('providerDeleteFailed'))
        return
      }
      panel.notifyOutcome?.('deleted')
      onDeleted()
    } catch {
      setFailure(t('providerDeleteFailed'))
    } finally {
      setBusy(false)
    }
  }
  const loginHint = config.authentication === 'chatgpt-managed' ? undefined : agentLoginHint(id, config)
  const probe = health?.probe
  const managed = config.authentication === 'chatgpt-managed'
  const needsAuthorization = managed && !config.authBinding
  const refreshUnavailable =
    config.enabled === false
      ? t('providerRefreshDisabled')
      : needsAuthorization
        ? t('providerRefreshAuthorize')
        : dirty
          ? t('providerRefreshSave')
          : busy
            ? t('saving')
            : undefined
  const showSection = (section: HTMLDetailsElement | null): void => {
    if (!section) return
    section.open = true
    requestAnimationFrame(() => section.querySelector('summary')?.focus())
  }
  const onAction = (action: string): void => {
    if (action === 'check') {
      showSection(connection.current)
      panel.refreshAgentHealth(id)
    } else if (action === 'settings') showSection(advanced.current)
    else if (action === 'removed') setShowHidden(true)
    else if (action === 'toggle') onToggle()
    else if (action === 'delete') setConfirming(true)
  }
  return h(
    'section',
    { className: css.detail, 'data-provider-detail': id, 'aria-label': config.name },
    h(
      'header',
      { className: css.detailHeader },
      h(
        'div',
        { className: css.identity },
        h(ProviderMark, { id, config }),
        h(
          'div',
          null,
          h('h2', null, config.name),
          h(
            'p',
            {
              className: css.state,
              'data-ready': config.enabled !== false && probe?.status === 'ok' && !needsAuthorization,
              'data-failed': config.enabled !== false && (probe?.status === 'error' || checkError !== undefined),
            },
            checkError !== undefined && config.enabled !== false
              ? t('providerProtocolError')
              : status(t, config, health),
          ),
        ),
      ),
      h(ProviderMenu, {
        label: t('providerInstanceActions'),
        items: [
          {
            id: 'check',
            label: t('providerCheck'),
            disabled: checking || refreshUnavailable !== undefined,
            icon: h(IconRefreshOutlineMedium, { size: 16 }),
          },
          { id: 'settings', label: t('providerAdvanced'), icon: h(IconSettingsOutlineMedium, { size: 16 }) },
          { id: 'removed', label: t('providerRemovedModels') },
          { type: 'separator', id: 'instance-management' },
          {
            id: 'toggle',
            label: t(config.enabled === false ? 'providerEnableAction' : 'providerDisableAction'),
            disabled: disabled || dirty,
          },
          {
            id: 'delete',
            label: t('providerDelete'),
            disabled,
            danger: true,
            icon: h(IconTrashOutlineMedium, { size: 16 }),
          },
        ],
        onSelect: onAction,
      }),
    ),
    needsAuthorization ? h(ManagedChatGptCard, { id, config, panel, t, readOnly }) : null,
    h(ProviderModels, {
      id,
      name: config.name,
      t,
      panel,
      catalog: config.enabled === false || needsAuthorization ? undefined : health?.modelCatalog,
      hiddenIds: config.hiddenModelIds ?? [],
      checking,
      checked: probe?.status === 'ok',
      failed: checkError !== undefined || probe?.status === 'error',
      unavailable: refreshUnavailable,
      readOnly: disabled,
      showHidden,
      onCloseHidden: () => setShowHidden(false),
    }),
    h(
      'details',
      { className: css.disclosure, ref: connection },
      h('summary', null, t('providerConnectionDetails'), h(IconChevronRightOutlineMedium, { size: 14 })),
      h(
        'div',
        { className: css.disclosureBody },
        h(
          'dl',
          { className: css.facts },
          h('dt', null, t('providerAuth')),
          h(
            'dd',
            null,
            t(
              managed
                ? 'managedAuthTitle'
                : probe?.status === 'error' && probe.failureKind === 'auth_required'
                  ? 'providerAuthRequired'
                  : 'providerAuthUnknown',
            ),
          ),
          h('dt', null, t('providerVersion')),
          h(
            'dd',
            null,
            (probe?.status === 'ok' ? probe.agentInfo?.version : undefined) ??
              health?.version ??
              t('providerVersionUnknown'),
          ),
          h('dt', null, t('providerLastChecked')),
          h('dd', null, probe?.at == null ? t('providerNotChecked') : new Date(probe.at).toLocaleString()),
        ),
        loginHint && probe?.status === 'error' && probe.failureKind === 'auth_required'
          ? h('p', { className: css.hint }, t('providerLoginCommand', { hint: loginHint }))
          : null,
        checkError !== undefined || probe?.status === 'error'
          ? h(
              'p',
              { className: css.error, role: 'status' },
              localizedDiagnostic(
                t,
                checkError
                  ? 'healthCheckTransportFailed'
                  : probe?.status === 'error' && probe.failureKind === 'spawn-failure'
                    ? 'probeNotInstalled'
                    : probe?.status === 'error' && probe.failureKind === 'auth_required'
                      ? 'probeAuthRequired'
                      : 'probeProtocolError',
                checkError ?? (probe?.status === 'error' ? probe.message : undefined),
                { command: config.command },
              ),
            )
          : null,
        managed && !needsAuthorization ? h(ManagedChatGptCard, { id, config, panel, t, readOnly }) : null,
      ),
    ),
    h(
      'details',
      { className: css.disclosure, ref: advanced },
      h('summary', null, t('providerAdvanced'), h(IconChevronRightOutlineMedium, { size: 14 })),
      h(
        'div',
        { className: css.disclosureBody },
        h(Field, {
          label: t('fieldName'),
          value: draft.name,
          disabled,
          error: error(validation.name),
          onChange: (name: string) => edit({ name }),
        }),
        h(Field, {
          label: t('fieldId'),
          value: id,
          disabled: true,
          hint: t('providerIdHelp'),
          onChange: () => undefined,
        }),
        h(RuntimeFields, { t, draft, edit, disabled, open: false }),
        h(EnvironmentFields, { t, draft, edit, disabled }),
        validation.env ? h('p', { className: css.error, role: 'alert' }, error(validation.env)) : null,
        h(
          'footer',
          { className: css.actions },
          h('span', { className: css.hint, role: 'status' }, saved ? t('providerSaved') : ''),
          h(
            Button,
            {
              variant: 'primary',
              disabled: disabled || !dirty || validation.config === undefined,
              onClick: () => void save(),
            },
            t(busy ? 'saving' : 'save'),
          ),
        ),
      ),
    ),
    failure && !confirming ? h('p', { className: css.error, role: 'alert' }, failure) : null,
    confirming
      ? h(
          Modal,
          {
            open: true,
            title: t('providerDeleteTitle'),
            description: t('providerDeleteHelp'),
            closeLabel: t('providerClose'),
            backdropBlur: false,
            onClose: () => {
              if (!busy) setConfirming(false)
            },
            footer: h(
              'div',
              { className: css.dialogActions },
              h(
                Button,
                {
                  variant: 'outline',
                  disabled: busy,
                  ...{ 'data-modal-autofocus': '' },
                  onClick: () => setConfirming(false),
                },
                t('cancel'),
              ),
              h(
                Button,
                { variant: 'primary', className: css.danger, disabled: busy, onClick: () => void remove() },
                t('providerDelete'),
              ),
            ),
          },
          count !== undefined ? h('p', null, t('removeConfirmBound', { count })) : null,
          failure ? h('p', { className: css.error, role: 'alert' }, failure) : null,
        )
      : null,
  )
}

function AddProvider({
  t,
  agents,
  panel,
  readOnly,
  checking,
  onCancel,
  onSaved,
}: {
  t: AcpTranslate
  agents: Record<string, AcpAgentConfig>
  panel: AcpSectionWire
  readOnly: boolean
  checking: boolean
  onCancel(): void
  onSaved(id: string): void
}): ReactNode {
  const [step, setStep] = useState(0)
  const [query, setQuery] = useState('')
  const [draft, setDraft] = useState<AgentDraft>(emptyDraft)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState(false)
  const heading = useRef<HTMLHeadingElement | null>(null)
  useEffect(() => {
    heading.current?.focus()
  }, [step])
  const validation = validateAgentDraft(draft, agents, undefined)
  const edit = (patch: Partial<AgentDraft>): void => {
    setDraft((previous) => ({ ...previous, ...patch }))
    setFailure(false)
  }
  const choose = (entryId: string | undefined): void => {
    setDraft(newProviderDraft(entryId, agents))
    setStep(1)
  }
  const chooseManaged = (): void => {
    const seed = newProviderDraft('codex-acp', agents)
    const existing = Object.entries(agents).find(([key, config]) => key === 'codex' || config.runtime === 'codex')?.[1]
    let id = 'codex-chatgpt',
      suffix = 1
    while (agents[id]) id = `codex-chatgpt-${++suffix}`
    setDraft({
      ...seed,
      id,
      name: suffix === 1 ? 'Codex · ChatGPT' : `Codex · ChatGPT ${suffix}`,
      command: existing?.command ?? seed.command,
      argsText: existing?.args.join('\n') ?? seed.argsText,
      envText: '',
      loginHint: '',
      runtime: 'codex',
      authentication: 'chatgpt-managed',
    })
    setStep(1)
  }
  const entry = catalogEntryOf(draft.catalogId ?? '')
  const entries = ACP_CATALOG_ENTRIES.filter((value) =>
    `${value.id} ${value.name}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
  )
  const save = async (): Promise<void> => {
    if (validation.config === undefined) return
    setBusy(true)
    setFailure(false)
    try {
      if ((await panel.saveAgent(undefined, draft)) !== undefined) {
        setFailure(true)
        return
      }
      panel.notifyOutcome?.('saved')
      onSaved(draft.id.trim())
      if (draft.authentication !== 'chatgpt-managed') panel.refreshAgentHealth(draft.id.trim())
    } catch {
      setFailure(true)
    } finally {
      setBusy(false)
    }
  }
  return h(
    'section',
    {
      className: css.detail,
      'data-provider-wizard': step,
      'aria-label': t('providerAdd'),
      onKeyDown: (event: { key: string; stopPropagation(): void }) => {
        if (event.key === 'Escape' && !busy) {
          event.stopPropagation()
          onCancel()
        }
      },
    },
    h(
      'header',
      { className: css.detailHeader },
      h(
        'div',
        null,
        h('p', { className: css.eyebrow }, t('providerStep', { step: step + 1 })),
        h(
          'h2',
          { ref: heading, tabIndex: -1 },
          t(step === 0 ? 'providerType' : step === 1 ? 'providerIdentity' : 'providerConfigure'),
        ),
      ),
      h(Button, { variant: 'ghost', disabled: busy || readOnly, onClick: onCancel }, t('cancel')),
    ),
    h(
      'ol',
      { className: css.steps, 'aria-label': t('providerAdd') },
      ...(['providerType', 'providerIdentity', 'providerConfigure'] as const).map((key, index) =>
        h('li', { key, 'aria-current': step === index ? 'step' : undefined }, `${index + 1}. ${t(key)}`),
      ),
    ),
    step === 0
      ? h(
          'div',
          { className: css.fields },
          h('p', { className: css.hint }, t('providerCatalogHint')),
          h(
            'button',
            { type: 'button', className: css.local, onClick: chooseManaged },
            h('strong', null, t('managedAuthType')),
            h('span', { className: css.hint }, t('managedAuthTypeHint')),
          ),
          h(Input, {
            type: 'search',
            value: query,
            'aria-label': t('providerCatalogSearch'),
            placeholder: t('providerCatalogSearch'),
            onChange: (event: { target: { value: string } }) => setQuery(event.target.value),
          }),
          h(
            'div',
            { className: css.catalog },
            ...entries.map((value) =>
              h(
                'button',
                { type: 'button', key: value.id, onClick: () => choose(value.id) },
                h('strong', null, value.name),
                h(
                  'span',
                  { className: css.hint },
                  value.verification === 'adapter-tested' ? t('providerCatalogTested') : value.id,
                ),
              ),
            ),
          ),
          entries.length === 0 ? h('p', { className: css.hint }, t('providerCatalogEmpty')) : null,
          h(
            'button',
            { type: 'button', className: css.local, onClick: () => choose(undefined) },
            h('strong', null, t('providerGeneric')),
            h('span', { className: css.hint }, t('providerLocalHint')),
          ),
        )
      : step === 1
        ? h(
            'div',
            { className: css.fields },
            h('p', { className: css.hint }, t('providerExistingHint')),
            h(Field, {
              label: t('fieldName'),
              value: draft.name,
              disabled: busy || readOnly,
              error: draft.name && validation.name ? t(validation.name.key) : undefined,
              onChange: (name: string) => edit({ name }),
            }),
            h(Field, {
              label: t('fieldId'),
              value: draft.id,
              disabled: busy || readOnly,
              hint: t('providerIdHelp'),
              error: draft.id && validation.id ? t(validation.id.key) : undefined,
              onChange: (id: string) => edit({ id }),
            }),
          )
        : h(
            'div',
            { className: css.fields },
            h('p', null, draft.name, ' · ', h('code', { className: css.hint }, `acp-${draft.id}`)),
            entry ? h('p', { className: css.hint }, t('catalogInstallHint', { hint: entry.installHint })) : null,
            h(RuntimeFields, { t, draft, edit, disabled: busy || readOnly, open: draft.runtime === undefined }),
            h(EnvironmentFields, { t, draft, edit, disabled: busy || readOnly }),
            validation.env
              ? h('p', { className: css.error, role: 'alert' }, t(validation.env.key, validation.env.params))
              : null,
            h(
              'p',
              { className: css.hint },
              t(draft.authentication === 'chatgpt-managed' ? 'managedAuthSaveHelp' : 'providerSavedCheck'),
            ),
          ),
    failure ? h('p', { className: css.error, role: 'alert' }, t('providerSaveFailed')) : null,
    step > 0
      ? h(
          'footer',
          { className: css.actions },
          h(
            Button,
            { variant: 'outline', disabled: busy || readOnly, onClick: () => setStep(step - 1) },
            t('providerBack'),
          ),
          h(
            Button,
            {
              variant: 'primary',
              disabled:
                busy ||
                readOnly ||
                (step === 2 && checking) ||
                (step === 1
                  ? validation.id !== undefined || validation.name !== undefined
                  : validation.config === undefined),
              onClick: () => (step === 1 ? setStep(2) : void save()),
            },
            t(
              busy
                ? 'saving'
                : step === 1
                  ? 'providerNext'
                  : draft.authentication === 'chatgpt-managed'
                    ? 'save'
                    : 'providerSaveCheck',
            ),
          ),
        )
      : null,
  )
}
