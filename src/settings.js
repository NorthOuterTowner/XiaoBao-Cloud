/**
 * The Settings panel: an in-page overlay with three sliders, a language switch and
 * the break reminders.
 *
 * It is part of the page, not a separate window, so the sliders feed the live cat
 * with no round trip -- drag the size and the cat resizes under your hand. The panel
 * is non-modal: the window stays click-through everywhere except over the panel (and
 * the cat). The renderer's hit test asks `contains()` / `capturing` each frame.
 *
 * The three values are the single source of truth for how big the cat and the fish
 * are drawn and how loud it is. The renderer reads `catScale`/`fishScale` every frame
 * and audio reads the volume; nothing here reaches into them.
 *
 * Every label comes from i18n, and the panel relabels itself when the 中/EN switch in
 * its title bar is flicked, so the change shows while the panel is open.
 *
 * Save / Cancel / Restore defaults: a drag is still a live preview -- that is the
 * point of an in-page panel -- but nothing is kept until Save. Opening the panel takes
 * a snapshot of everything it can change (the three values, both reminders, the
 * language); Cancel puts that snapshot back, and so does closing the panel any other
 * way. Restore defaults loads the factory values as another preview, still yours to
 * Save or Cancel.
 */

import { language, setLanguage, onLanguage, t } from './i18n.js';

/** Each slider: the setting it drives, its range as shown, and how it reads out. */
const SLIDERS = [
  {
    key: 'volume',
    label: 'volume',
    min: 0,
    max: 100,
    step: 1,
    format: (v) => `${Math.round(v)}%`,
  },
  {
    key: 'catScale',
    label: 'catSize',
    min: 60,
    max: 180,
    step: 1,
    format: (v) => `${Math.round(v)}%`,
  },
  {
    // Shown as a share of the cat: 100 means "as big as the cat", which is the whole
    // joke -- wind it up and the cat is offered a fish its own size.
    key: 'fishScale',
    label: 'fishSize',
    min: 20,
    max: 100,
    step: 1,
    format: (v) => (v >= 100 ? t('fishAsBigAsCat') : `${Math.round(v)}%`),
  },
];

/** Defaults, in the slider's own units (percent). */
const DEFAULTS = { volume: 30, catScale: 100, fishScale: 45 };
// Saved values outlive a restart, so Save means what it says.
const VALUE_STORE = 'xiaobao.settings';

function loadValues() {
  const out = { ...DEFAULTS };
  try {
    const saved = JSON.parse(localStorage.getItem(VALUE_STORE) || '{}');
    for (const { key, min, max } of SLIDERS) {
      const v = saved[key];
      // Clamped, not trusted: a hand-edited or stale value must not draw a cat the
      // size of the screen.
      if (Number.isFinite(v)) out[key] = Math.min(max, Math.max(min, v));
    }
  } catch {
    // No storage, or nothing saved yet: the defaults stand.
  }
  return out;
}

/**
 * The break reminders: one slider each, in minutes, and nothing else. The slider runs
 * in notches of `step` up to `max`, and its lowest notch -- zero -- is the reminder
 * switched off, so turning one off and setting how often it comes are the same
 * gesture.
 */
const REMINDERS = [
  { kind: 'eyes', label: 'eyesReminder', max: 60, step: 5 },
  { kind: 'walk', label: 'walkReminder', max: 120, step: 10 },
];
// Reminder settings outlive a restart: someone who turned a reminder off should not
// have it come back every time the cat starts.
const REMINDER_STORE = 'xiaobao.reminders';

/** Nearest notch on a reminder's slider, never zero -- zero means off. */
function snap(minutes, { max, step }) {
  const stepped = Math.round(minutes / step) * step;
  return Math.min(max, Math.max(step, stepped));
}

function loadReminders(defaults) {
  try {
    const saved = JSON.parse(localStorage.getItem(REMINDER_STORE) || '{}');
    const out = {};
    for (const [kind, d] of Object.entries(defaults)) {
      const s = saved[kind] || {};
      out[kind] = {
        enabled: typeof s.enabled === 'boolean' ? s.enabled : d.enabled,
        minutes: Number.isFinite(s.minutes) ? s.minutes : d.minutes,
      };
    }
    return out;
  } catch {
    return structuredClone(defaults);
  }
}

export class Settings {
  /**
   * @param {object} hooks
   * @param {(volume: number) => void} hooks.onVolume  0..1.
   */
  constructor({ onVolume, reminderDefaults, onReminder }) {
    this.onVolume = onVolume;
    // Called with (kind, { enabled, minutes }) when a reminder setting is saved.
    this.onReminder = onReminder;
    this.reminderDefaults = structuredClone(reminderDefaults);
    /** { eyes: { enabled, minutes }, walk: {...} }, saved across restarts. */
    this.reminders = loadReminders(reminderDefaults);
    // An interval saved before the sliders had notches (or hand-edited) would not sit
    // on one; put it on the nearest, so the slider and the countdown agree.
    for (const spec of REMINDERS) {
      const value = this.reminders[spec.kind];
      if (value) value.minutes = snap(value.minutes, spec);
    }
    // What the reminders were when they were last saved, so Save only disturbs the
    // countdown of a reminder that actually changed.
    this.savedReminders = structuredClone(this.reminders);
    // True from a mousedown on the panel until the matching mouseup, so the renderer
    // keeps the window holding the mouse through a slider or title drag that slides
    // off the panel.
    this.capturing = false;
    // Set by the renderer: called when the cat-size slider moves, so the live cat is
    // re-laid-out under the user's hand. Fish size is read lazily, so needs no hook.
    this.onCatSize = null;
    this.values = loadValues();
    // What the panel will go back to on Cancel; filled in each time it opens.
    this.snapshot = null;
    this.open = false;
    this._build();
    this._apply('volume');
    onLanguage(() => this._relabel());
  }

  /** Cat height as a multiple of its default. Read by the renderer every frame. */
  get catScale() {
    return this.values.catScale / 100;
  }

  /**
   * Fish length as a fraction of the cat's height. At the top of the range this is
   * 1.0 -- a fish as tall as the cat -- which is why the renderer sizes the fish off
   * the cat's current drawn height.
   */
  get fishScale() {
    return this.values.fishScale / 100;
  }

  /**
   * Show the panel next to the cat.
   * @param {number} catX - the cat's current left edge, in window pixels.
   * @param {number} catWidth - the cat's render width.
   * @param {number} catBottom - the cat's bottom edge from the window top.
   */
  show(catX, catWidth, catBottom) {
    if (this.open) return;
    this.open = true;
    this.root.hidden = false;
    // Everything the panel can change, as it stands now: Cancel puts this back.
    this.snapshot = {
      lang: language(),
      values: { ...this.values },
      reminders: structuredClone(this.reminders),
    };
    // Position the panel to the right of the cat, flipping to the left side if the
    // cat is too close to the right edge of the screen. The panel sits above the cat
    // a bit, so it doesn't cover it.
    const PANEL_WIDTH = 300;
    // Measured now it is shown, so adding rows never needs this kept in step.
    const PANEL_HEIGHT = this.root.offsetHeight || 240;
    const padding = 12;
    const under = window.innerWidth - (catX + catWidth + padding + PANEL_WIDTH);
    const flipLeft = under < 0;
    const left = flipLeft ? catX - PANEL_WIDTH - padding : catX + catWidth + padding;
    // Place it above the cat's feet, keeping it inside the window top.
    const top = Math.max(padding, catBottom - PANEL_HEIGHT - padding);
    this.root.style.left = `${left}px`;
    this.root.style.top = `${top}px`;
    this.root.style.right = 'auto';
    this.root.style.bottom = 'auto';
    // No global mouse grab: the window stays click-through, only the panel's own
    // interactive elements (the sliders and the buttons) receive events.
  }

  /**
   * Close the panel, throwing away anything not saved -- so the menu item that
   * toggles it shut means the same as Cancel, rather than quietly keeping a size the
   * user was only trying out.
   */
  hide() {
    if (!this.open) return;
    this._cancel();
  }

  // ---- save, cancel, defaults ------------------------------------------------------

  /** Keep what is on screen: write it down, and hand the reminders their new timing. */
  _save() {
    try {
      localStorage.setItem(VALUE_STORE, JSON.stringify(this.values));
      localStorage.setItem(REMINDER_STORE, JSON.stringify(this.reminders));
    } catch {
      // Storage unavailable: the settings still apply for this run.
    }
    for (const { kind } of REMINDERS) {
      const value = this.reminders[kind];
      const before = this.savedReminders[kind];
      // Configuring a reminder restarts its countdown, so leave alone the one that
      // was not touched.
      if (before && before.enabled === value.enabled && before.minutes === value.minutes) continue;
      if (this.onReminder) this.onReminder(kind, { ...value });
    }
    this.savedReminders = structuredClone(this.reminders);
    this._close();
  }

  /** Put back whatever was in force when the panel opened, then close. */
  _cancel() {
    const was = this.snapshot;
    if (was) {
      this.reminders = structuredClone(was.reminders);
      this._load(was.values);
      // Last, so the relabel that comes with it lands on the restored values.
      setLanguage(was.lang);
    }
    this._close();
  }

  /** The factory settings, as a preview: still Save or Cancel from here. */
  _restoreDefaults() {
    this.reminders = structuredClone(this.reminderDefaults);
    for (const spec of REMINDERS) {
      const value = this.reminders[spec.kind];
      if (value) value.minutes = snap(value.minutes, spec);
    }
    this._load(DEFAULTS);
  }

  /** Take a set of slider values, push them to the controls, the cat and the audio. */
  _load(values) {
    this.values = { ...values };
    for (const { key } of SLIDERS) {
      this.sliders[key].value = String(this.values[key]);
      this._readout(key);
    }
    for (const kind of Object.keys(this.reminderRows)) {
      const value = this.reminders[kind];
      this.reminderRows[kind].range.value = String(value.enabled ? value.minutes : 0);
      this._reminderReadout(kind);
    }
    this.onVolume(this.values.volume / 100);
    if (this.onCatSize) this.onCatSize();
  }

  _close() {
    this.open = false;
    this.root.hidden = true;
    this.capturing = false;
    this.dragging = null;
    this.snapshot = null;
  }

  /** Is this window-relative point on the panel? Used by the renderer's hit test. */
  contains(x, y) {
    if (!this.open) return false;
    const r = this.root.getBoundingClientRect();
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  }

  // ---- dragging --------------------------------------------------------------------

  _onDragStart(event) {
    if (event.button !== 0) return;
    // Any press on the panel holds the mouse until release (sliders included).
    this.capturing = true;
    // Only the title bar moves the panel; the sliders, the language switch and the
    // button keep their own press.
    const onTitle = event.target.closest('.settings-title');
    if (!onTitle || event.target.closest('.lang-switch')) return;
    this.dragging = {
      startX: event.clientX,
      startY: event.clientY,
      startLeft: this.root.offsetLeft,
      startTop: this.root.offsetTop,
    };
    event.preventDefault();
  }

  _onDrag(event) {
    if (!this.dragging) return;
    // A missed mouseup (released outside the window) would leave the panel stuck.
    if (event.buttons === 0) {
      this._onDragEnd();
      return;
    }
    const dx = event.clientX - this.dragging.startX;
    const dy = event.clientY - this.dragging.startY;
    // Keep the title bar reachable: clamp the panel inside the window.
    const maxLeft = window.innerWidth - this.root.offsetWidth;
    const maxTop = window.innerHeight - this.root.offsetHeight;
    const left = Math.min(Math.max(0, this.dragging.startLeft + dx), Math.max(0, maxLeft));
    const top = Math.min(Math.max(0, this.dragging.startTop + dy), Math.max(0, maxTop));
    this.root.style.left = `${left}px`;
    this.root.style.top = `${top}px`;
  }

  _onDragEnd() {
    this.dragging = null;
    this.capturing = false;
  }

  // ---- building the panel ---------------------------------------------------------

  _build() {
    this.dragging = null;
    this.root = document.createElement('div');
    this.root.id = 'settings';
    this.root.hidden = true;
    this.root.dataset.lang = language();
    // Dragging the title moves the whole panel.
    this.root.addEventListener('mousedown', (e) => this._onDragStart(e));
    window.addEventListener('mousemove', (e) => this._onDrag(e));
    window.addEventListener('mouseup', () => this._onDragEnd());

    const title = document.createElement('div');
    title.className = 'settings-title';
    this.titleText = document.createElement('span');
    this.titleText.className = 'settings-title-text';
    this.titleText.textContent = t('settings');
    title.append(this.titleText, this._buildLanguageSwitch());
    this.root.appendChild(title);

    this.readouts = {};
    this.labels = {};
    /** The range inputs by key, so Cancel and Restore can put values back on them. */
    this.sliders = {};
    for (const slider of SLIDERS) {
      const row = document.createElement('label');
      row.className = 'settings-row';

      const name = document.createElement('span');
      name.className = 'settings-label';
      name.textContent = t(slider.label);

      const value = document.createElement('span');
      value.className = 'settings-value';

      const input = document.createElement('input');
      input.type = 'range';
      input.min = String(slider.min);
      input.max = String(slider.max);
      input.step = String(slider.step);
      input.value = String(this.values[slider.key]);
      input.addEventListener('input', () => {
        this.values[slider.key] = Number(input.value);
        this._apply(slider.key);
      });

      row.append(name, input, value);
      this.root.appendChild(row);
      this.readouts[slider.key] = { value, format: slider.format };
      this.labels[slider.key] = { name, key: slider.label };
      this.sliders[slider.key] = input;
      this._readout(slider.key);
    }

    this._buildReminders();
    this.root.appendChild(this._buildFooter());

    document.body.appendChild(this.root);
  }

  /**
   * The footer: Restore defaults off to the left, away from the pair that closes the
   * panel, so it is not reached for by accident. Save is the one that keeps anything.
   */
  _buildFooter() {
    const footer = document.createElement('div');
    footer.className = 'settings-footer';

    const button = (className, label, onClick) => {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = className;
      el.textContent = t(label);
      el.addEventListener('click', onClick);
      footer.appendChild(el);
      return { el, label };
    };

    this.footerButtons = [
      button('settings-button settings-restore', 'restoreDefaults', () => this._restoreDefaults()),
      button('settings-button', 'cancel', () => this._cancel()),
      button('settings-button settings-save', 'save', () => this._save()),
    ];
    return footer;
  }

  /**
   * The 中 / EN switch in the title bar: a pill with a knob that slides to the side
   * you press. Clicking a side picks that language rather than toggling blindly, so
   * the switch reads the same way it looks.
   */
  _buildLanguageSwitch() {
    const sw = document.createElement('div');
    sw.className = 'lang-switch';
    sw.setAttribute('role', 'group');
    sw.setAttribute('aria-label', t('languageAria'));
    sw.dataset.lang = language();

    const knob = document.createElement('span');
    knob.className = 'lang-knob';
    knob.setAttribute('aria-hidden', 'true');
    sw.appendChild(knob);

    this.langButtons = [];
    for (const [lang, text] of [
      ['zh', '中'],
      ['en', 'EN'],
    ]) {
      const option = document.createElement('button');
      option.type = 'button';
      option.className = 'lang-option';
      option.dataset.value = lang;
      option.textContent = text;
      option.setAttribute('aria-pressed', String(language() === lang));
      option.addEventListener('click', () => setLanguage(lang));
      sw.appendChild(option);
      this.langButtons.push(option);
    }

    this.langSwitch = sw;
    return sw;
  }

  _buildReminders() {
    this.reminderHeading = document.createElement('div');
    this.reminderHeading.className = 'settings-section';
    this.reminderHeading.textContent = t('breakReminders');
    this.root.appendChild(this.reminderHeading);

    /** Per kind: the label, the slider and its readout, so _relabel can refresh them. */
    this.reminderRows = {};

    for (const spec of REMINDERS) {
      const { kind, label, max, step } = spec;
      const value = this.reminders[kind];

      const row = document.createElement('label');
      row.className = 'settings-row';

      const name = document.createElement('span');
      name.className = 'settings-label';

      const range = document.createElement('input');
      range.type = 'range';
      // Zero is the "off" notch; the notches above it are the interval in minutes.
      range.min = '0';
      range.max = String(max);
      range.step = String(step);
      range.value = String(value.enabled ? value.minutes : 0);

      const readout = document.createElement('span');
      readout.className = 'settings-value';

      row.append(name, range, readout);
      this.root.appendChild(row);
      this.reminderRows[kind] = { spec, name, range, readout };
      this._reminderReadout(kind);

      // Read through `this.reminders` rather than the object captured above: Cancel
      // and Restore defaults put a fresh one in its place.
      range.addEventListener('input', () => {
        const minutes = Number(range.value);
        const current = this.reminders[kind];
        current.enabled = minutes > 0;
        // Off keeps the interval it had, so turning it back on does not forget it.
        if (minutes > 0) current.minutes = minutes;
        this._reminderReadout(kind);
      });
      // Nothing reaches the countdown until Save, so there is no 'change' to commit.
    }
  }

  /** Label and value for one reminder row, in the current language. */
  _reminderReadout(kind) {
    const { spec, name, range, readout } = this.reminderRows[kind];
    const value = this.reminders[kind];
    name.textContent = t(spec.label);
    range.setAttribute('aria-label', t('reminderAria', t(spec.label)));
    readout.textContent = value.enabled ? t('reminderEvery', value.minutes) : t('reminderOff');
    readout.classList.toggle('settings-value-off', !value.enabled);
  }

  /** Re-read every label after the language switch. */
  _relabel() {
    const lang = language();
    this.root.dataset.lang = lang;
    this.langSwitch.dataset.lang = lang;
    this.langSwitch.setAttribute('aria-label', t('languageAria'));
    for (const option of this.langButtons) {
      option.setAttribute('aria-pressed', String(option.dataset.value === lang));
    }
    this.titleText.textContent = t('settings');
    for (const { name, key } of Object.values(this.labels)) name.textContent = t(key);
    for (const key of Object.keys(this.readouts)) this._readout(key);
    this.reminderHeading.textContent = t('breakReminders');
    for (const kind of Object.keys(this.reminderRows)) this._reminderReadout(kind);
    for (const { el, label } of this.footerButtons) el.textContent = t(label);
  }

  _readout(key) {
    const { value, format } = this.readouts[key];
    value.textContent = format(this.values[key]);
  }

  _apply(key) {
    this._readout(key);
    if (key === 'volume') this.onVolume(this.values.volume / 100);
    // Cat size resizes the live cat now; fish size is read the next time a fish
    // appears, so it needs no push.
    if (key === 'catScale' && this.onCatSize) this.onCatSize();
  }
}
