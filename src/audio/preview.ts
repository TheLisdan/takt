import type { Transport } from '../engine/transport'
import type { MidiIn } from '../midi/input'
import { loopBounds, type SongNote } from '../midi/parse'

interface Voice {
  pitch: number
  osc: OscillatorNode
  partial: OscillatorNode
  gain: GainNode
}

interface LiveNote {
  pitch: number
  end: number
}

/** Short triangle piano. No samples, a handful of voices, so the Intel GPU/CPU stays free. */
class TinyPiano {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private readonly voices: Voice[] = []

  unlock() {
    const ctx = this.context()
    if (ctx.state === 'suspended') void ctx.resume()
  }

  get running(): boolean {
    return this.ctx?.state === 'running'
  }

  start(pitch: number, velocity: number) {
    const ctx = this.context()
    const now = ctx.currentTime
    const freq = 440 * 2 ** ((pitch - 69) / 12)
    const osc = ctx.createOscillator()
    osc.type = 'triangle'
    osc.frequency.value = freq
    const partial = ctx.createOscillator()
    partial.type = 'sine'
    partial.frequency.value = freq * 2
    const partialGain = ctx.createGain()
    partialGain.gain.value = 0.15
    const filter = ctx.createBiquadFilter()
    filter.type = 'lowpass'
    filter.Q.value = 0.6
    filter.frequency.setValueAtTime(Math.min(4800, freq * 5), now)
    filter.frequency.exponentialRampToValueAtTime(Math.max(160, freq), now + 0.3)
    const gain = ctx.createGain()
    const peak = Math.min(0.28, 0.04 + Math.max(0, velocity) * 0.2)
    gain.gain.setValueAtTime(0.0001, now)
    gain.gain.exponentialRampToValueAtTime(peak, now + 0.01)
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, peak * 0.4), now + 0.16)
    osc.connect(filter)
    partial.connect(partialGain)
    partialGain.connect(filter)
    filter.connect(gain)
    gain.connect(this.master!)
    osc.start(now)
    partial.start(now)
    this.voices.push({ pitch, osc, partial, gain })
    if (this.voices.length > 24) this.quiet(this.voices.shift()!)
  }

  stopPitch(pitch: number) {
    for (let i = this.voices.length - 1; i >= 0; i--) {
      if (this.voices[i].pitch !== pitch) continue
      this.quiet(this.voices[i])
      this.voices.splice(i, 1)
    }
  }

  stopAll() {
    for (const voice of this.voices) this.quiet(voice)
    this.voices.length = 0
  }

  private quiet(voice: Voice) {
    const ctx = this.ctx
    if (!ctx) return
    const now = ctx.currentTime
    try {
      voice.gain.gain.cancelScheduledValues(now)
      voice.gain.gain.setValueAtTime(Math.max(0.0001, voice.gain.gain.value), now)
      voice.gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.04)
      voice.osc.stop(now + 0.05)
      voice.partial.stop(now + 0.05)
    } catch {
      /* already stopped */
    }
  }

  private context(): AudioContext {
    if (!this.ctx) {
      const ctx = new AudioContext()
      const master = ctx.createGain()
      master.gain.value = 0.22
      master.connect(ctx.destination)
      this.ctx = ctx
      this.master = master
    }
    return this.ctx
  }
}

export class Preview {
  private readonly piano = new TinyPiano()
  private readonly live = new Map<number, LiveNote>()
  private readonly held = new Map<number, number>()
  private cursor = 0
  private prev: number | null = null

  constructor(private readonly midi: MidiIn) {}

  unlock() {
    if (!this.midi.hasOutput) this.piano.unlock()
  }

  get usingHardware(): boolean {
    return this.midi.hasOutput
  }

  get activeNotes(): number {
    return this.live.size
  }

  get browserRunning(): boolean {
    return this.piano.running
  }

  halt() {
    this.releaseAll()
    this.cursor = 0
    this.prev = null
  }

  follow(transport: Transport) {
    const song = transport.song
    const audible = transport.playing && transport.mode === 'listen' && song
    if (!audible || !song) {
      if (this.live.size || this.prev !== null) this.halt()
      return
    }
    const time = transport.time
    if (this.prev === null || time < this.prev - 0.01) {
      this.releaseAll()
      this.cursor = lowerBound(song.notes, time)
      this.prev = time
      return
    }
    const from = this.prev
    const bounds = transport.loopOn ? loopBounds(song, transport.loopFrom, transport.loopTo) : null
    const notes = song.notes
    while (this.cursor < notes.length && notes[this.cursor].time <= time + 0.0004) {
      const note = notes[this.cursor++]
      if (note.time <= from || note.end <= time) continue
      if (bounds && (note.time < bounds.start - 0.0005 || note.time >= bounds.end - 0.0005)) continue
      const level = loudness(song, note, transport.hand)
      if (level === 0) continue
      this.begin(note, level)
    }
    for (const [id, info] of this.live) {
      if (info.end <= time) this.end(id, info.pitch)
    }
    this.prev = time
  }

  private begin(note: SongNote, level: number) {
    const count = this.held.get(note.midi) ?? 0
    this.held.set(note.midi, count + 1)
    this.live.set(note.id, { pitch: note.midi, end: note.end })
    if (count > 0) return
    if (this.midi.hasOutput) {
      const velocity = Math.round(48 + level * 48)
      if (!this.midi.note(note.midi, true, velocity)) this.piano.start(note.midi, level)
      return
    }
    this.piano.start(note.midi, level)
  }

  private end(id: number, pitch: number) {
    this.live.delete(id)
    const count = this.held.get(pitch) ?? 0
    if (count <= 1) {
      this.held.delete(pitch)
      if (this.midi.hasOutput) this.midi.note(pitch, false, 0)
      else this.piano.stopPitch(pitch)
      return
    }
    this.held.set(pitch, count - 1)
  }

  private releaseAll() {
    if (this.midi.hasOutput) {
      for (const pitch of this.held.keys()) this.midi.note(pitch, false, 0)
    }
    this.held.clear()
    this.live.clear()
    this.piano.stopAll()
  }
}

function loudness(song: Transport['song'], note: SongNote, hand: Transport['hand']): number {
  if (!song) return 0
  const track = song.tracks[note.track]
  if (!track || track.hand === 'off') return 0
  const base = Math.max(0.15, Math.min(1, note.velocity || 0.7))
  if (hand === 'both' || note.hand === hand) return base
  return base * 0.42
}

function lowerBound(notes: SongNote[], time: number): number {
  let lo = 0
  let hi = notes.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (notes[mid].time < time) lo = mid + 1
    else hi = mid
  }
  return lo
}
