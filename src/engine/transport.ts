import { barAtTime, loopBounds, pitchNameRu, type Song, type SongNote } from '../midi/parse'

export type HandMode = 'L' | 'R' | 'both'
export type PlayMode = 'wait' | 'listen'

const LEAD_SEC = 1

export class Transport {
  song: Song | null = null
  time = 0
  playing = false
  waiting = false
  hand: HandMode = 'both'
  mode: PlayMode = 'wait'
  speed = 1
  loopOn = false
  loopFrom = 1
  loopTo = 1
  readonly held = new Set<number>()
  readonly wrongUntil = new Map<number, number>()

  private chordPos = 0
  private armed = -1
  private readonly need = new Set<number>()
  private readonly got = new Set<number>()
  private lastTs = 0

  setSong(song: Song) {
    this.song = song
    this.playing = false
    this.loopOn = false
    this.loopFrom = 1
    this.loopTo = Math.max(1, song.bars.length)
    this.restartClock(true)
  }

  togglePlay() {
    if (!this.song) return
    if (this.playing) {
      this.playing = false
      return
    }
    const end = this.activeEnd()
    if (this.time >= end - 0.02) {
      if (this.loopOn) this.engageLoop(this.loopFrom, this.loopTo)
      else this.restartClock(true)
    }
    this.playing = true
    this.lastTs = 0
  }

  setHand(hand: HandMode) {
    this.hand = hand
    this.dropGate()
  }

  setMode(mode: PlayMode) {
    this.mode = mode
    if (mode === 'listen') this.dropGate()
  }

  setSpeed(speed: number) {
    this.speed = Math.min(1, Math.max(0.5, speed))
  }

  /** Move the playhead without turning the loop on. */
  seekBy(seconds: number) {
    if (!this.song || !Number.isFinite(seconds) || seconds === 0) return
    const next = clamp(this.time + seconds, Math.min(0, this.time), this.song.duration)
    if (next === this.time) return
    this.time = next
    this.chordPos = 0
    this.dropGate()
    this.clearHits(next, Number.POSITIVE_INFINITY)
  }

  engageLoop(from: number, to: number) {
    if (!this.song) return
    const max = this.song.bars.length || 1
    this.loopFrom = clamp(Math.min(from, to), 1, max)
    this.loopTo = clamp(Math.max(from, to), 1, max)
    this.loopOn = true
    const bounds = this.bounds()
    if (!bounds) return
    this.clearHits(bounds.start, bounds.end)
    this.chordPos = 0
    this.dropGate()
    this.time = bounds.start
    this.leadIn()
  }

  disableLoop() {
    this.loopOn = false
    this.dropGate()
  }

  refreshGates() {
    this.dropGate()
  }

  noteOn(pitch: number, now: number) {
    this.held.add(pitch)
    if (!this.playing || !this.waiting || this.armed < 0) return
    if (this.need.has(pitch)) {
      this.got.add(pitch)
      if (this.needCovered()) this.complete()
    } else {
      this.wrongUntil.set(pitch, now + 220)
    }
  }

  noteOff(pitch: number) {
    this.held.delete(pitch)
  }

  tick(now: number) {
    if (this.lastTs === 0) {
      this.lastTs = now
      this.sweep(now)
      return
    }
    let dt = (now - this.lastTs) / 1000
    this.lastTs = now
    if (dt < 0) dt = 0
    if (dt > 0.25) dt = 0.25
    this.sweep(now)
    if (!this.playing || !this.song) return
    if (this.mode === 'wait') this.advanceWait(dt)
    else this.advanceListen(dt)
  }

  fillExpected(out: SongNote[]) {
    out.length = 0
    if (!this.song || this.mode !== 'wait') return
    const index = this.armed >= 0 ? this.armed : this.nextGateIndex()
    if (index < 0) return
    const notes = this.song.chords[index].notes
    for (let i = 0; i < notes.length; i++) {
      if (this.noteIsRequired(notes[i])) out.push(notes[i])
    }
    out.sort((a, b) => a.midi - b.midi)
  }

  displayBar(): number {
    if (!this.song) return 1
    const bounds = this.bounds()
    const time = bounds ? Math.max(this.time, bounds.start) : Math.max(this.time, 0)
    return barAtTime(this.song, time)
  }

  private advanceWait(dt: number) {
    const song = this.song!
    if (this.waiting && this.armed >= 0) {
      this.time = song.chords[this.armed].time
      return
    }
    const gate = this.nextGateIndex()
    let next = this.time + dt * this.speed
    if (gate >= 0 && next > song.chords[gate].time) next = song.chords[gate].time
    const bounds = this.bounds()
    if (bounds && next >= bounds.end - 0.0005) {
      this.wrap()
      return
    }
    if (!bounds && next >= song.duration) {
      this.time = song.duration
      this.playing = false
      return
    }
    this.time = next
    if (gate >= 0 && this.time >= song.chords[gate].time - 0.0005) {
      this.time = song.chords[gate].time
      this.arm(gate)
    }
  }

  private advanceListen(dt: number) {
    const song = this.song!
    let next = this.time + dt * this.speed
    const bounds = this.bounds()
    if (bounds && next >= bounds.end - 0.0005) {
      this.wrap()
      return
    }
    if (next >= song.duration) {
      this.time = song.duration
      this.playing = false
      return
    }
    this.time = next
  }

  private nextGateIndex(): number {
    const song = this.song
    if (!song) return -1
    const bounds = this.bounds()
    const chords = song.chords
    for (let i = this.chordPos; i < chords.length; i++) {
      const chord = chords[i]
      if (chord.time < this.time - 0.001) continue
      if (bounds && chord.time < bounds.start - 0.0005) continue
      if (bounds && chord.time >= bounds.end - 0.0005) return -1
      if (this.requiredCount(chord.notes) > 0) return i
    }
    return -1
  }

  private arm(index: number) {
    const chord = this.song!.chords[index]
    if (this.armed !== index) {
      this.armed = index
      this.got.clear()
      this.need.clear()
      for (const note of chord.notes) {
        if (this.noteIsRequired(note)) this.need.add(note.midi)
      }
    }
    this.chordPos = index
    this.waiting = this.need.size > 0
  }

  private complete() {
    const chord = this.song!.chords[this.armed]
    for (const note of chord.notes) {
      if (this.noteIsRequired(note)) note.hit = true
    }
    this.chordPos = this.armed + 1
    this.time = chord.time + 0.0001
    this.dropGate()
  }

  private noteIsRequired(note: SongNote): boolean {
    const track = this.song?.tracks[note.track]
    if (!track || track.hand === 'off') return false
    if (this.hand === 'both') return true
    return note.hand === this.hand
  }

  private requiredCount(notes: SongNote[]): number {
    let count = 0
    for (let i = 0; i < notes.length; i++) if (this.noteIsRequired(notes[i])) count++
    return count
  }

  private needCovered(): boolean {
    if (this.need.size === 0) return false
    for (const pitch of this.need) if (!this.got.has(pitch)) return false
    return true
  }

  private dropGate() {
    this.waiting = false
    this.armed = -1
    this.got.clear()
    this.need.clear()
  }

  private leadIn() {
    const index = this.nextGateIndex()
    if (index < 0 || !this.song) return
    const when = this.song.chords[index].time
    if (when - this.time < 0.05) this.time = when - LEAD_SEC
  }

  private wrap() {
    const bounds = this.bounds()
    if (!bounds) return
    this.clearHits(bounds.start, bounds.end)
    this.chordPos = 0
    this.dropGate()
    this.time = bounds.start
    this.leadIn()
  }

  private restartClock(withLead: boolean) {
    this.chordPos = 0
    this.dropGate()
    this.clearHits(Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY)
    this.time = 0
    if (withLead) this.leadIn()
  }

  private clearHits(start: number, end: number) {
    const notes = this.song?.notes
    if (!notes) return
    for (let i = 0; i < notes.length; i++) {
      const note = notes[i]
      if (note.time >= start - 0.0005 && note.time < end - 0.0005) note.hit = false
    }
  }

  private bounds(): { start: number; end: number } | null {
    if (!this.loopOn || !this.song) return null
    return loopBounds(this.song, this.loopFrom, this.loopTo)
  }

  private activeEnd(): number {
    return this.bounds()?.end ?? this.song?.duration ?? 0
  }

  private sweep(now: number) {
    for (const [pitch, until] of this.wrongUntil) {
      if (until <= now) this.wrongUntil.delete(pitch)
    }
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export function waitingLabel(notes: SongNote[]): string {
  if (!notes.length) return ''
  return notes.map((note) => pitchNameRu(note.midi)).join(' + ')
}
