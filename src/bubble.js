/**
 * The speech bubble the cat uses for break reminders: a line of text with, while it
 * is asking, three answer buttons underneath.
 *
 * Like the Settings panel it is part of the page. The window is click-through
 * everywhere the renderer's hit test says so; `contains()` is how the bubble keeps
 * the mouse while the cursor is on it, so its buttons can be pressed.
 */

const GAP = 10; // px between the top of the cat's head and the bubble's tail
const EDGE = 8; // keep this far inside the window

export class Bubble {
  constructor() {
    this.root = document.createElement('div');
    this.root.id = 'bubble';
    this.root.hidden = true;
    this.root.setAttribute('role', 'dialog');
    this.root.setAttribute('aria-live', 'polite');

    this.text = document.createElement('p');
    this.text.className = 'bubble-text';
    this.buttons = document.createElement('div');
    this.buttons.className = 'bubble-choices';
    this.tail = document.createElement('div');
    this.tail.className = 'bubble-tail';
    this.root.append(this.text, this.buttons, this.tail);
    document.body.appendChild(this.root);
    this.open = false;
  }

  /**
   * Ask: `text` above one button per choice. `onChoice(id)` fires once, with the
   * pressed choice's id.
   */
  ask(text, choices, onChoice) {
    this.text.textContent = text;
    this.buttons.replaceChildren(
      ...choices.map(({ id, label }) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = label;
        b.dataset.choice = id;
        b.addEventListener('click', () => onChoice(id), { once: true });
        return b;
      })
    );
    this.buttons.hidden = false;
    this._show();
  }

  /** Just a line from the cat, no buttons. */
  say(text) {
    this.text.textContent = text;
    this.buttons.replaceChildren();
    this.buttons.hidden = true;
    this._show();
  }

  hide() {
    this.open = false;
    this.root.hidden = true;
    this.buttons.replaceChildren();
  }

  _show() {
    this.open = true;
    this.root.hidden = false;
    // Replay the pop-in on every new line.
    this.root.classList.remove('pop');
    void this.root.offsetWidth;
    this.root.classList.add('pop');
  }

  /**
   * Put the bubble over the cat: centred on `centreX`, its tail just above `headTop`
   * (window px). Clamped inside the window; the tail keeps pointing at the cat.
   */
  place(centreX, headTop) {
    if (!this.open) return;
    const w = this.root.offsetWidth;
    const h = this.root.offsetHeight;
    const left = Math.min(Math.max(EDGE, centreX - w / 2), Math.max(EDGE, window.innerWidth - w - EDGE));
    const top = Math.max(EDGE, headTop - GAP - h);
    this.root.style.left = `${Math.round(left)}px`;
    this.root.style.top = `${Math.round(top)}px`;
    const tailX = Math.min(Math.max(18, centreX - left), w - 18);
    this.tail.style.left = `${Math.round(tailX)}px`;
  }

  /** Is this window-relative point on the bubble? Used by the renderer's hit test. */
  contains(x, y) {
    if (!this.open) return false;
    const r = this.root.getBoundingClientRect();
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom + GAP;
  }
}
