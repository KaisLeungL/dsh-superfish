import { createElement as h, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  Button,
  IconCopyOutlineMedium,
  IconEllipsisOutlineMedium,
  IconRefreshOutlineMedium,
  IconTrashOutlineMedium,
  Menu,
  Modal,
  type MenuEntry,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { AcpModelCatalogView } from '../../contract/remote.ts'
import type { AcpSectionWire, AcpTranslate } from './AcpSection.ts'
import css from './ProviderManagement.module.css'

export function ProviderMenu({
  label,
  items,
  onSelect,
  disabled,
}: {
  label: string
  items: readonly MenuEntry[]
  onSelect(id: string): void
  disabled?: boolean
}): ReactNode {
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  return h(Menu, {
    anchor: h(Button, {
      ref: trigger,
      type: 'button',
      variant: 'ghost',
      size: 'sm',
      className: css.more,
      icon: h(IconEllipsisOutlineMedium, { size: 16 }),
      'aria-label': label,
      title: label,
      'aria-haspopup': 'menu',
      'aria-expanded': open,
      disabled,
      onClick: () => setOpen((previous) => !previous),
    }),
    open,
    items,
    onSelect,
    onClose: () => setOpen(false),
    returnFocus: () => trigger.current,
    align: 'end',
    compact: true,
    autoFocus: true,
    portal: true,
  })
}

type Model = AcpModelCatalogView['models'][number]
type ModelDialog = { kind: 'remove' | 'copy'; model: Model } | { kind: 'hidden' }

function catalogUpdatedAt(at: number, t: AcpTranslate): string {
  const date = new Date(at)
  const time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }).replaceAll(' ', '\u00a0')
  return date.toDateString() === new Date().toDateString()
    ? t('providerCatalogToday', { time })
    : `${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${time}`
}

export function ProviderModels({
  id,
  name,
  t,
  panel,
  catalog,
  hiddenIds,
  checking,
  failed,
  checked,
  unavailable,
  readOnly,
  showHidden,
  onCloseHidden,
}: {
  id: string
  name: string
  t: AcpTranslate
  panel: AcpSectionWire
  catalog: AcpModelCatalogView | undefined
  hiddenIds: readonly string[]
  checking: boolean
  failed: boolean
  checked: boolean
  unavailable: string | undefined
  readOnly: boolean
  showHidden: boolean
  onCloseHidden(): void
}): ReactNode {
  const [dialog, setDialog] = useState<ModelDialog | undefined>(undefined)
  const [pending, setPending] = useState(false)
  const [failure, setFailure] = useState(false)
  const [notice, setNotice] = useState('')
  const [undo, setUndo] = useState<Model | undefined>(undefined)
  const refresh = useRef<HTMLButtonElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const active = dialog ?? (showHidden ? { kind: 'hidden' } : undefined)
  const hidden = new Set(hiddenIds)
  const models = catalog?.models.filter((model) => !hidden.has(model.id)) ?? []
  const hiddenModels = hiddenIds.map(
    (modelId) => catalog?.models.find((model) => model.id === modelId) ?? { id: modelId, name: modelId },
  )
  const close = (): void => {
    setDialog(undefined)
    onCloseHidden()
    setFailure(false)
  }
  const changeVisibility = async (model: Model, hide: boolean): Promise<void> => {
    setPending(true)
    setFailure(false)
    try {
      const error = await panel.setModelHidden(id, model.id, hide)
      if (error !== undefined) {
        setFailure(true)
        return
      }
      setUndo(hide ? model : undefined)
      setNotice(t(hide ? 'providerModelRemoved' : 'providerModelRestored'))
      close()
      if (hide) requestAnimationFrame(() => (refresh.current?.disabled ? heading.current : refresh.current)?.focus())
    } catch {
      setFailure(true)
    } finally {
      setPending(false)
    }
  }
  const copy = async (model: Model): Promise<void> => {
    try {
      await navigator.clipboard.writeText(model.id)
      setNotice(t('providerModelCopied'))
      setUndo(undefined)
      setFailure(false)
    } catch {
      setDialog({ kind: 'copy', model })
    }
  }
  const meta =
    catalog === undefined
      ? (unavailable ?? t(checked && !failed ? 'providerCatalogUnavailable' : 'providerCatalogUnread'))
      : `${t('providerVisibleModelCount', { count: models.length })} · ${t('providerCatalogUpdated', {
          time: catalogUpdatedAt(catalog.at, t),
        })}`
  const error = h('p', { className: css.error, role: 'alert' }, t('providerModelVisibilityFailed'))
  const dismiss = (): void => {
    if (!pending) close()
  }
  const title =
    active?.kind === 'hidden'
      ? t('providerRemovedModels')
      : active?.kind === 'remove'
        ? t('providerRemoveModelTitle')
        : t('providerModelId')
  return h(
    'section',
    { className: css.models, 'aria-label': t('providerInstanceModels', { name }) },
    h(
      'div',
      { className: css.modelsHeader },
      h(
        'div',
        null,
        h('h3', { ref: heading, tabIndex: -1 }, t('providerInstanceModels', { name })),
        h('p', { className: css.hint, role: 'status' }, meta),
      ),
      h(
        Button,
        {
          ref: refresh,
          type: 'button',
          size: 'sm',
          variant: 'primary',
          className: css.refresh,
          icon: h(IconRefreshOutlineMedium, { size: 16 }),
          disabled: checking || unavailable !== undefined,
          'aria-busy': checking,
          onClick: () => panel.refreshAgentHealth(id),
        },
        t(checking ? 'providerRefreshingModels' : 'providerRefreshModels'),
      ),
    ),
    catalog !== undefined && unavailable !== undefined
      ? h('p', { className: css.modelsEmpty, role: 'status' }, unavailable)
      : null,
    failed && !checking && unavailable === undefined
      ? h(
          'p',
          { className: css.modelError, role: 'status' },
          t(catalog === undefined ? 'providerRefreshFailed' : 'providerRefreshRetained'),
        )
      : null,
    models.length === 0
      ? catalog !== undefined
        ? h(
            'p',
            { className: css.modelsEmpty },
            t(catalog.models.length === 0 ? 'providerModelCatalogEmpty' : 'providerCatalogHidden'),
          )
        : null
      : h(
          'ul',
          { className: css.modelList },
          ...models.map((model) =>
            h(
              'li',
              { key: model.id, className: css.modelRow, 'data-provider-model': model.id },
              h('span', { className: css.modelName }, model.name),
              h(ProviderMenu, {
                label: t('providerModelMenu', { name: model.name }),
                items: [
                  { id: 'copy', label: t('providerCopyModelId'), icon: h(IconCopyOutlineMedium, { size: 16 }) },
                  { type: 'separator', id: 'remove-model' },
                  {
                    id: 'remove',
                    label: t('providerRemoveModel'),
                    danger: true,
                    disabled: readOnly || pending,
                    icon: h(IconTrashOutlineMedium, { size: 16 }),
                  },
                ],
                onSelect: (action) => {
                  if (action === 'copy') void copy(model)
                  else setDialog({ kind: 'remove', model })
                },
              }),
            ),
          ),
        ),
    notice !== '' || (failure && active === undefined)
      ? h(
          'div',
          { className: css.modelFeedback },
          h('span', { role: 'status' }, notice),
          undo === undefined
            ? null
            : h(
                Button,
                {
                  type: 'button',
                  size: 'sm',
                  disabled: pending || readOnly,
                  onClick: () => void changeVisibility(undo, false),
                },
                t('providerUndoModelRemoval'),
              ),
          failure && active === undefined ? error : null,
        )
      : null,
    !active
      ? null
      : h(
          Modal,
          {
            open: true,
            title,
            closeLabel: t('providerClose'),
            onClose: dismiss,
            backdropBlur: false,
            ...(active.kind === 'remove'
              ? { description: t('providerRemoveModelHelp', { name: active.model.name }) }
              : {}),
            footer: h(
              'div',
              { className: css.dialogActions },
              h(
                Button,
                {
                  type: 'button',
                  variant: 'outline',
                  disabled: pending,
                  onClick: dismiss,
                  ...{ 'data-modal-autofocus': '' },
                },
                t(active.kind === 'remove' ? 'cancel' : 'providerDone'),
              ),
              active.kind === 'remove'
                ? h(
                    Button,
                    {
                      type: 'button',
                      variant: 'primary',
                      className: css.danger,
                      disabled: pending || readOnly,
                      onClick: () => void changeVisibility(active.model, true),
                    },
                    t('providerRemoveModel'),
                  )
                : null,
            ),
          },
          active.kind === 'copy'
            ? h('code', { className: css.modelName }, active.model.id)
            : active.kind === 'hidden'
              ? hiddenModels.length === 0
                ? h('p', { className: css.hint }, t('providerNoRemovedModels'))
                : h(
                    'ul',
                    { className: css.hiddenList },
                    ...hiddenModels.map((model) =>
                      h(
                        'li',
                        { key: model.id, className: css.modelRow },
                        h('span', { className: css.modelName }, model.name),
                        h(
                          Button,
                          {
                            variant: 'outline',
                            size: 'sm',
                            disabled: pending || readOnly,
                            onClick: () => void changeVisibility(model, false),
                          },
                          t('providerRestoreModel'),
                        ),
                      ),
                    ),
                  )
              : null,
          failure ? error : null,
        ),
  )
}
