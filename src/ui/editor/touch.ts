/**
 * Touch on the canvas: one finger works like the mouse; two fingers pan and pinch-zoom the view;
 * holding a finger still opens the canvas menu; two quick taps act as a double-click. This class
 * only decides what each touch means, so it can be tested without a browser.
 */

type Point = { x: number; y: number };

/** How long a finger must stay still to open the menu (ms). */
export const LONG_PRESS_MS = 550;
/** Movement that turns a press into a drag (screen px). */
const SLOP = 8;
/** Two taps this close in time (ms) and space (px) are a double tap. */
const DOUBLE_TAP_MS = 320;
const DOUBLE_TAP_PX = 24;

export type PinchStep = { dx: number; dy: number; zoom: number; at: Point };

const centre = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

export class TouchGestures {
  private points = new Map<number, Point>();
  /** Two fingers down: the view follows them until every finger has lifted. */
  private pinch: { centre: Point; dist: number } | null = null;
  private press: { id: number; start: Point; moved: boolean } | null = null;
  private lastTap: { time: number; at: Point } | null = null;
  /** A long press opened the menu: the rest of that touch does nothing. */
  private held = false;

  get pinching() {
    return this.pinch !== null;
  }

  /** A finger went down: 'editor' passes it on, 'pinch' means the editor's drag must be cancelled. */
  down(id: number, at: Point): 'editor' | 'pinch' | 'ignore' {
    this.points.set(id, at);
    if (this.pinch) {
      // a finger back down mid-pinch: measure from the new pair, or the view would jump
      if (this.points.size === 2) {
        const [a, b] = [...this.points.values()];
        this.pinch = { centre: centre(a, b), dist: Math.max(1, dist(a, b)) };
      }
      return 'ignore';
    }
    if (this.points.size === 2) {
      const [a, b] = [...this.points.values()];
      this.pinch = { centre: centre(a, b), dist: Math.max(1, dist(a, b)) };
      this.press = null;
      this.lastTap = null;
      return 'pinch';
    }
    if (this.points.size > 2) return 'ignore';
    this.held = false;
    this.press = { id, start: at, moved: false };
    return 'editor';
  }

  /** A finger moved: a pan-and-zoom step while pinching, else whether the editor should see it. */
  move(id: number, at: Point): PinchStep | 'editor' | 'ignore' {
    if (!this.points.has(id)) return 'editor';
    this.points.set(id, at);
    if (this.press?.id === id && dist(at, this.press.start) > SLOP) this.press.moved = true;
    if (this.pinch) {
      if (this.points.size < 2) return 'ignore';
      const [a, b] = [...this.points.values()];
      const c = centre(a, b);
      const d = Math.max(1, dist(a, b));
      const step = { dx: c.x - this.pinch.centre.x, dy: c.y - this.pinch.centre.y, zoom: d / this.pinch.dist, at: c };
      this.pinch = { centre: c, dist: d };
      return step;
    }
    return this.held ? 'ignore' : 'editor';
  }

  /**
   * The long-press timer fired for this finger: true if it is still down and has not moved,
   * so the menu should open (and the editor's drag be cancelled).
   */
  longPress(id: number): boolean {
    if (this.pinch || this.press?.id !== id || this.press.moved || !this.points.has(id)) return false;
    this.held = true;
    this.press = null;
    return true;
  }

  /** A finger lifted: 'double-tap' when it ends a second quick tap in the same place. */
  up(id: number, at: Point, time: number): 'editor' | 'double-tap' | 'ignore' {
    if (!this.points.delete(id)) return 'editor';
    if (this.pinch) {
      if (this.points.size === 0) this.pinch = null;
      return 'ignore';
    }
    if (this.held) {
      this.held = false;
      return 'ignore';
    }
    const tap = this.press?.id === id && !this.press.moved;
    this.press = null;
    if (!tap) {
      this.lastTap = null;
      return 'editor';
    }
    if (this.lastTap && time - this.lastTap.time <= DOUBLE_TAP_MS && dist(at, this.lastTap.at) <= DOUBLE_TAP_PX) {
      this.lastTap = null;
      return 'double-tap';
    }
    this.lastTap = { time, at };
    return 'editor';
  }

  /** The browser took the touch away (a scroll, an alert): forget it. */
  cancel(id: number) {
    this.points.delete(id);
    if (this.points.size === 0) this.pinch = null;
    if (this.press?.id === id) this.press = null;
  }
}
