/**
 * Break reminders: rest your eyes, get up and walk about.
 *
 * DOM-free, like Brain. The renderer ticks it, asks it whether a reminder is due,
 * shows the prompt, and reports which button was pressed (or that the bubble timed
 * out). Everything the cat says comes from here, picked at random each time so the
 * same reminder does not read the same way twice in a row.
 *
 * Timing:
 *   - Each kind counts down on its own, from its interval in minutes.
 *   - The countdown stops while the cat is paused.
 *   - A reminder that comes due while the cat cannot show it (held, falling, being
 *     fed) waits until it can.
 *   - "一会再提醒我" brings the same reminder back in SNOOZE_MINUTES and adds that
 *     to how long the user has been "busy"; the next prompt says so.
 *   - Any other answer, or no answer within the bubble's timeout, starts the full
 *     interval over.
 */

export const SNOOZE_MINUTES = 5;
// After one reminder finishes, another that came due meanwhile waits this long, so
// the two never arrive back to back.
const GAP_SECONDS = 20;

export const DEFAULT_CONFIG = {
  eyes: { enabled: true, minutes: 20 },
  walk: { enabled: true, minutes: 50 },
};

/** The three answers, in the order the buttons are shown. */
export const CHOICES = [
  { id: 'go', label: '知道了，现在就去' },
  { id: 'later', label: '在忙，一会再提醒我' },
  { id: 'skip', label: '太忙了，不用了' },
];

const TEXT = {
  eyes: {
    prompt: [
      '盯着屏幕好久啦，看看远处休息一下眼睛吧~',
      '眼睛累了吗，可以试试找个 6 米外的东西看 20 秒',
      '眨眨眼看看窗外吧，让眼睛好好歇一歇~',
      '屏幕看太久啦，陪我一起望望远处嘛',
    ],
    // Appended after "已经忙了 N 分钟了，"
    snoozed: [
      '眼睛真的要休息一下啦',
      '就看远处 20 秒呗，好不好？',
      '再不休息眼睛要抗议了',
      '我都替你的眼睛累了……',
    ],
    go: [
      '好耶！看远处的时候别偷偷看手机哦',
      '好~ 我帮你盯着屏幕',
      '眼睛会谢谢你的',
    ],
    later: [
      '好吧，五分钟后我再来喊你',
      '那我先在这里等你一会儿',
      '嗯嗯，记得忙完这一点就去休息',
    ],
    skip: [
      '好吧……那记得多眨眨眼',
      '那你先忙吧，别太累了',
      '好的，我会安静陪着你的',
    ],
  },
  walk: {
    prompt: [
      '坐了好久啦，起来走一走吧~',
      '快点起来活动活动',
      '去倒杯水，顺便走两步吧',
      '久坐对身体不好哦，起来动一动~',
    ],
    snoozed: [
      '真的该起来动一动啦',
      '我都坐不住了，你还坐得住吗',
    ],
    go: [
      '去吧！顺便喝口水吧',
      '记得活动一下肩膀哦',
      '记得活动一下颈椎哦'
    ],
    later: [
      '好吧，五分钟后我再来叫你',
      '那我先趴这儿等你一下',
      '那说好了五分钟后要起来',
      '嗯嗯，忙完这一段就动一动吧',
    ],
    skip: [
      '好吧……那坐直一点吧，保护颈椎',
      '那你忙吧，别忘了喝水',
      '下次一定要起来呀',
      '好的，忙完记得自己去休息休息',
    ],
  },
};

export class Reminders {
  /** `config` is `{ eyes: { enabled, minutes }, walk: {...} }`; missing parts use the defaults. */
  constructor({ config = {}, rng = Math.random } = {}) {
    this.rng = rng;
    this.kinds = {};
    for (const [kind, defaults] of Object.entries(DEFAULT_CONFIG)) {
      const c = { ...defaults, ...(config[kind] || {}) };
      this.kinds[kind] = { ...c, left: c.minutes * 60, busy: 0 };
    }
    /** The reminder on screen right now: { kind, text, busy } or null. */
    this.active = null;
    this.gap = 0;
    // Last line said per text list, so a pick never repeats the one before it.
    this.lastLine = new Map();
  }

  /** Change a kind's switch or interval. Either change starts its countdown over. */
  configure(kind, { enabled, minutes }) {
    const k = this.kinds[kind];
    if (!k) return;
    if (enabled != null) k.enabled = enabled;
    if (minutes != null) k.minutes = minutes;
    k.left = k.minutes * 60;
    k.busy = 0;
  }

  config() {
    return Object.fromEntries(
      Object.entries(this.kinds).map(([kind, { enabled, minutes }]) => [kind, { enabled, minutes }])
    );
  }

  /**
   * Advance the countdowns. `paused` stops them. Returns the reminder that should be
   * shown now, or null. `canShow` false defers a due reminder without losing it.
   * The caller must answer (or time out) a returned reminder before the next one.
   */
  update(dt, { paused = false, canShow = true } = {}) {
    if (paused || this.active) return null;
    this.gap = Math.max(0, this.gap - dt);
    for (const k of Object.values(this.kinds)) {
      if (k.enabled) k.left = Math.max(0, k.left - dt);
    }
    if (!canShow || this.gap > 0) return null;
    // The one that has been due longest first; walk wins a tie, it is rarer.
    const due = Object.entries(this.kinds)
      .filter(([, k]) => k.enabled && k.left <= 0)
      .sort(([a], [b]) => (a === 'walk' ? -1 : b === 'walk' ? 1 : 0));
    if (!due.length) return null;
    const [kind, k] = due[0];
    const text = k.busy
      ? `已经忙了${k.busy}分钟了，${this._line(kind, 'snoozed')}`
      : this._line(kind, 'prompt');
    this.active = { kind, text, busy: k.busy };
    return this.active;
  }

  /** The user pressed a button. Returns what the cat says back. */
  answer(choice) {
    const a = this.active;
    if (!a) return '';
    const k = this.kinds[a.kind];
    if (choice === 'later') {
      k.busy += SNOOZE_MINUTES;
      k.left = SNOOZE_MINUTES * 60;
    } else {
      k.busy = 0;
      k.left = k.minutes * 60;
    }
    this._finish();
    return this._line(a.kind, choice === 'later' ? 'later' : choice === 'skip' ? 'skip' : 'go');
  }

  /** Nobody answered: assume the user went for the break. */
  timeout() {
    const a = this.active;
    if (!a) return;
    const k = this.kinds[a.kind];
    k.busy = 0;
    k.left = k.minutes * 60;
    this._finish();
  }

  /**
   * The cat could not finish showing it (picked up, say). The reminder stays due
   * and comes back once the cat is free.
   */
  abandon() {
    if (!this.active) return;
    this.active = null;
    this.gap = 3;
  }

  _finish() {
    this.active = null;
    this.gap = GAP_SECONDS;
  }

  _line(kind, list) {
    const lines = TEXT[kind][list];
    const key = `${kind}.${list}`;
    const options = lines.length > 1 ? lines.filter((l) => l !== this.lastLine.get(key)) : lines;
    const line = options[Math.floor(this.rng() * options.length)];
    this.lastLine.set(key, line);
    return line;
  }
}
