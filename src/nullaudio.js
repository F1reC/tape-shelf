// Silent stand-in used only if the real audio engine fails to load: keeps the transport and reels working.
export class NullAudio {
  constructor() { this.state = 'stop'; this.paused = false; this.position = 0; this.duration = 0; this.tapeSpeed = 0; this.unlocked = false; this.onAutoStop = null; this._target = 0; }
  async unlock() { this.unlocked = true; }
  prepare(tape) { return Promise.resolve({ buffer: null, duration: 150, tracks: (tape.tracks || []).map((title, i) => ({ title, start: i * 36, end: i * 36 + 34 })) }); }
  async loadFile(file) { return { buffer: null, duration: 180, tracks: [{ title: file.name, start: 0, end: 180 }] }; }
  setTape(info, position = 0) { this.duration = info ? info.duration : 0; this.position = position; }
  removeTape() { const p = this.position; this.duration = 0; this.position = 0; this.state = 'stop'; this._target = 0; this.tapeSpeed = 0; return p; }
  play() { if (!this.duration) return; this.state = 'play'; this._target = this.paused ? 0 : 1; }
  stop() { this.state = 'stop'; this._target = 0; }
  ff() { if (!this.duration) return; this.state = 'ff'; this._target = Math.max(24, this.duration / 6); }
  rew() { if (!this.duration) return; this.state = 'rew'; this._target = -Math.max(24, this.duration / 6); }
  pause(on) { this.paused = on; if (this.state === 'play') this._target = on ? 0 : 1; }
  update(dt) {
    this.tapeSpeed += (this._target - this.tapeSpeed) * (1 - Math.exp(-dt * 8));
    this.position += this.tapeSpeed * dt;
    if (this.duration && (this.position >= this.duration || this.position <= 0) && this.state !== 'stop') {
      const end = this.position >= this.duration;
      if ((end && this.tapeSpeed > 0) || (!end && this.tapeSpeed < 0)) {
        this.position = Math.min(this.duration, Math.max(0, this.position)); this.state = 'stop'; this._target = 0; this.tapeSpeed = 0;
        this.onAutoStop?.(end ? 'end' : 'start');
      }
    }
    this.position = Math.min(this.duration, Math.max(0, this.position));
  }
  setVolume() {} setTone() {} setNR() {} setPower() {} sfx() {}
  getLevels() { return { l: 0, r: 0, bass: 0 }; }
}
