import {
  DEFAULT_CONFIG,
  isValidPrefix,
  normalizeFolder,
  slugifyColumnId,
  type BoardConfig,
  type Column,
} from '@oprojects/core';
import { Notice, PluginSettingTab, Setting, type App, type TextComponent } from 'obsidian';
import { t } from './i18n';
import type CardsPlugin from './main';

/** Commit a text field when it loses focus or Enter is pressed (not on every keystroke: each commit rescans/saves). */
function commitOnBlur(text: TextComponent, commit: (value: string) => void): TextComponent {
  const el = text.inputEl;
  el.addEventListener('blur', () => commit(text.getValue()));
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') el.blur();
  });
  return text;
}

export class CardsSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: CardsPlugin,
  ) {
    super(app, plugin);
  }

  override display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const cfg = () => this.plugin.config;
    const save = (patch: Partial<BoardConfig>) => this.plugin.updateConfig({ ...cfg(), ...patch });

    new Setting(containerEl)
      .setName(t('settings.folder'))
      .setDesc(t('settings.folder.desc'))
      .addText((text) =>
        commitOnBlur(text.setPlaceholder(DEFAULT_CONFIG.folder).setValue(cfg().folder), (v) => {
          const folder = normalizeFolder(v) || DEFAULT_CONFIG.folder;
          text.setValue(folder);
          if (folder !== cfg().folder) void save({ folder });
        }),
      );

    new Setting(containerEl)
      .setName(t('settings.prefix'))
      .setDesc(t('settings.prefix.desc'))
      .addText((text) =>
        commitOnBlur(text.setPlaceholder(DEFAULT_CONFIG.prefix).setValue(cfg().prefix), (v) => {
          const prefix = v.trim().toUpperCase();
          if (!isValidPrefix(prefix)) {
            new Notice(t('settings.invalidPrefix'));
            text.setValue(cfg().prefix);
            return;
          }
          text.setValue(prefix);
          if (prefix !== cfg().prefix) void save({ prefix });
        }),
      );

    new Setting(containerEl)
      .setName(t('settings.me'))
      .setDesc(t('settings.me.desc'))
      .addText((text) =>
        commitOnBlur(text.setValue(cfg().me), (v) => v.trim() !== cfg().me && void save({ me: v.trim() })),
      );

    new Setting(containerEl)
      .setName(t('settings.members'))
      .setDesc(t('settings.members.desc'))
      .addText((text) =>
        commitOnBlur(text.setPlaceholder('Ana, Bruno').setValue(cfg().members.join(', ')), (v) => {
          const members = v
            .split(',')
            .map((m) => m.trim())
            .filter(Boolean);
          if (members.join('\n') !== cfg().members.join('\n')) void save({ members });
        }),
      );

    new Setting(containerEl)
      .setName(t('settings.hide'))
      .setDesc(t('settings.hide.desc'))
      .addText((text) => {
        text.inputEl.type = 'number';
        text.inputEl.min = '0';
        return commitOnBlur(text.setValue(String(cfg().hideDoneAfterDays)), (v) => {
          const days = Math.max(0, Math.floor(Number(v)) || 0);
          text.setValue(String(days));
          if (days !== cfg().hideDoneAfterDays) void save({ hideDoneAfterDays: days });
        });
      });

    this.renderColumns(containerEl);
  }

  private renderColumns(containerEl: HTMLElement): void {
    new Setting(containerEl).setName(t('settings.columns')).setDesc(t('settings.columns.desc')).setHeading();

    const columns = () => this.plugin.config.columns;
    const saveColumns = async (next: Column[]) => {
      await this.plugin.updateConfig({ ...this.plugin.config, columns: next });
      this.display();
    };
    const replace = (i: number, patch: Partial<Column>) =>
      columns().map((c, idx) => (idx === i ? Object.assign({}, c, patch) : c));

    columns().forEach((column, i) => {
      new Setting(containerEl)
        .setClass('op-setting-column')
        .setName(`#${i + 1}`)
        // The id is what cards store and what the CLI accepts (`oprojects move 12 ${column.id}`).
        .setDesc(`id: ${column.id}`)
        .addText((text) =>
          commitOnBlur(
            text.setPlaceholder(t('settings.column.name')).setValue(column.name),
            (v) => v.trim() && v.trim() !== column.name && void saveColumns(replace(i, { name: v.trim() })),
          ),
        )
        .addToggle((toggle) =>
          toggle
            .setTooltip(t('settings.column.done'))
            .setValue(!!column.done)
            .onChange((done) => void saveColumns(replace(i, { done: done || undefined }))),
        )
        .addText((text) => {
          text.inputEl.type = 'number';
          text.inputEl.min = '0';
          text.inputEl.style.width = '64px';
          return commitOnBlur(
            text.setPlaceholder(t('settings.column.wip')).setValue(column.wip ? String(column.wip) : ''),
            (v) => {
              const wip = Math.max(0, Math.floor(Number(v)) || 0);
              if (wip !== (column.wip ?? 0)) void saveColumns(replace(i, { wip: wip || undefined }));
            },
          );
        })
        .addExtraButton((b) =>
          b
            .setIcon('arrow-left')
            .setTooltip(t('settings.column.up'))
            .setDisabled(i === 0)
            .onClick(() => {
              const next = [...columns()];
              [next[i - 1], next[i]] = [next[i]!, next[i - 1]!];
              void saveColumns(next);
            }),
        )
        .addExtraButton((b) =>
          b
            .setIcon('arrow-right')
            .setTooltip(t('settings.column.down'))
            .setDisabled(i === columns().length - 1)
            .onClick(() => {
              const next = [...columns()];
              [next[i + 1], next[i]] = [next[i]!, next[i + 1]!];
              void saveColumns(next);
            }),
        )
        .addExtraButton((b) =>
          b
            .setIcon('trash')
            .setTooltip(t('settings.column.remove'))
            .onClick(() => {
              if (columns().length <= 1) return void new Notice(t('settings.column.last'));
              void saveColumns(columns().filter((_, idx) => idx !== i));
            }),
        );
    });

    new Setting(containerEl).addButton((b) =>
      b.setButtonText(t('settings.column.add')).onClick(() => {
        const taken = new Set(columns().map((c) => c.id));
        const base = slugifyColumnId(t('settings.column.name'));
        let id = base;
        for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
        void saveColumns([
          ...columns(),
          { id, name: t('settings.column.name') + (id === base ? '' : ` ${id.slice(base.length + 1)}`) },
        ]);
      }),
    );
  }
}
