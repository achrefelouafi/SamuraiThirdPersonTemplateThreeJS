/**
 * The boot veil.
 *
 * Owns the markup already in `index.html` rather than creating its own, so the
 * first paint happens before any JavaScript has run.
 */
export class LoadingScreen {
  constructor() {
    this.root = document.getElementById('loader');
    this.fill = document.getElementById('loader-fill');
    this.status = document.getElementById('loader-status');
  }

  /**
   * @param {number} value 0..1
   * @param {string} [message]
   */
  setProgress(value, message) {
    if (this.fill) this.fill.style.width = `${Math.round(Math.min(1, Math.max(0, value)) * 100)}%`;
    if (message && this.status) this.status.textContent = message;
  }

  hide() {
    this.root?.classList.add('loader--done');
  }

  /** Leave the veil up and say what went wrong. */
  fail(message) {
    if (this.status) this.status.textContent = message;
    this.root?.classList.remove('loader--done');
    this.root?.classList.add('loader--failed');
  }
}
