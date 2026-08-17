/**
 * One-line transient messages, bottom centre.
 *
 * The editor is the only thing that talks: preset saved, settings imported,
 * reset to defaults. Each message replaces the last and clears itself.
 */
export class Toast {
  constructor(parent = document.body) {
    this.element = document.createElement('div');
    this.element.className = 'toast';
    parent.appendChild(this.element);
    this._timer = 0;
  }

  show(message, duration = 2200) {
    this.element.textContent = message;
    this.element.classList.add('is-visible');
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.element.classList.remove('is-visible'), duration);
  }

  dispose() {
    clearTimeout(this._timer);
    this.element.remove();
  }
}
