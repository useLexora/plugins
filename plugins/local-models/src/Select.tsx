import React, { useEffect, useState } from 'react'
import { Combobox, Group, InputBase, ScrollArea, useCombobox } from '@mantine/core'
import { Icon } from './ui'

export interface SelectOption<Value extends string = string> {
  value: Value
  label: string
  disabled?: boolean
  icon?: string | React.ReactElement
}

export type SelectProps<Value extends string = string> = Omit<React.ComponentPropsWithoutRef<'button'>, 'value' | 'onChange' | 'children' | 'defaultValue'> & {
  value: Value
  onChange: (value: Value) => void
  options: readonly SelectOption<Value>[]
  placeholder?: string
  compact?: boolean
}

export function Select<Value extends string = string>({ value, onChange, options, disabled = false, placeholder, compact = false, className, ...props }: SelectProps<Value>) {
  const selected = options.find(option => option.value === value)
  const [boundaryOption, setBoundaryOption] = useState<string | undefined>()
  const combobox = useCombobox({ onDropdownOpen: () => combobox.updateSelectedOptionIndex('active'), onDropdownClose: () => { combobox.resetSelectedOption(); setBoundaryOption(undefined) } })
  useEffect(() => { if (disabled) combobox.closeDropdown() }, [disabled])
  const icon = option => option?.icon && (typeof option.icon === 'string' ? <Icon name={option.icon} /> : option.icon)
  return <Combobox store={combobox} withinPortal={false} onOptionSubmit={next => {
    const option = options.find(option => option.value === next)
    if (option && !option.disabled) onChange(option.value)
    combobox.closeDropdown(); combobox.focusTarget()
  }}>
    <Combobox.Target targetType="button" withExpandedAttribute {...(boundaryOption ? { 'aria-activedescendant': boundaryOption } : {})}>
      <InputBase {...props} component="button" type="button" disabled={disabled} pointer size="sm" variant={compact ? 'unstyled' : 'default'} className={['model-select', compact && 'is-compact', className].filter(Boolean).join(' ')} classNames={{ input: 'model-select-trigger' }} rightSection={<Combobox.Chevron />} rightSectionPointerEvents="none" onClick={() => combobox.toggleDropdown()} onKeyDown={event => {
        setBoundaryOption(undefined)
        if (!combobox.dropdownOpened) return
        if (event.key === 'Escape') { event.stopPropagation(); combobox.closeDropdown() }
        if (event.key === 'Home' || event.key === 'End') {
          event.preventDefault()
          combobox.resetSelectedOption()
          const id = event.key === 'Home' ? combobox.selectFirstOption() : combobox.selectPreviousOption()
          setBoundaryOption(id ?? undefined)
        }
      }}>
        <Group gap={6} wrap="nowrap">{icon(selected)}<span className="model-select-label">{selected?.label ?? placeholder}</span></Group>
      </InputBase>
    </Combobox.Target>
    <Combobox.Dropdown onKeyDown={event => { if (event.key === 'Escape') event.stopPropagation() }}>
      <ScrollArea.Autosize mah={280} type="auto">
        <Combobox.Options>{options.map(option => <Combobox.Option value={option.value} key={option.value} disabled={option.disabled} active={option.value === value}>
          <Group gap={8} wrap="nowrap">{icon(option)}<span className="model-select-label">{option.label}</span>{option.value === value && <Icon name="check" size={14} />}</Group>
        </Combobox.Option>)}</Combobox.Options>
      </ScrollArea.Autosize>
    </Combobox.Dropdown>
  </Combobox>
}
