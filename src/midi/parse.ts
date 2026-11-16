import { Midi } from '@tonejs/midi'

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const
const RU = ['до', 'до#', 'ре', 'ре#', 'ми', 'фа', 'фа#', 'соль', 'соль#', 'ля', 'ля#', 'си'] as const
const WHITE_IN_OCTAVE = [0, 0, 1, 1, 2, 3, 3, 4, 4, 5, 5, 6]

export type TrackHand = 'L' | 'R' | 'off'

export interface SongTrack {
  index: number
  name: string
  drums: boolean
  noteCount: number
  avgPitch: number
  hand: TrackHand
}

export interface SongNote {
  id: number
  midi: number
  time: number
  duration: number
  end: number
  ticks: number
  velocity: number
  track: number
  hand: 'L' | 'R'
  bar: number
  hit: boolean
}

export interface Chord {
  ticks: number
  time: number
  notes: SongNote[]
}

export interface Bar {
  number: number
  startTick: number
  endTick: number
  startSec: number
  endSec: number
  num: number
  den: number
  /** Доли внутри такта, без сильной доли в начале. */
  beatSec: number[]
}

export interface TempoMark {
  ticks: number
  time: number
  bpm: number
}

export interface Song {
  name: string
  notes: SongNote[]
  chords: Chord[]
  bars: Bar[]
  tempos: TempoMark[]
  tracks: SongTrack[]
  ppq: number
  lastTick: number
  fileSignatures: { ticks: number; num: number; den: number }[]
  /** Пусто — размер из файла. Иначе «3/4» и такты пересчитаны с начала. */
  meterOverride: string
  splitMode: 'pitch' | 'tracks'
  splitPitch: number
  duration: number
  maxDuration: number
}

export function pitchName(midi: number): string {
  const n = midi | 0
  const pc = ((n % 12) + 12) % 12
  return NAMES[pc] + (Math.floor(n / 12) - 1)
}

export function pitchNameRu(midi: number): string {
  const n = midi | 0
  const pc = ((n % 12) + 12) % 12
  return RU[pc] + (Math.floor(n / 12) - 1)
}

export function isBlack(midi: number): boolean {
  const pc = ((midi % 12) + 12) % 12
  return pc === 1 || pc === 3 || pc === 6 || pc === 8 || pc === 10
}

export function whiteIndex(midi: number): number {
  const n = midi | 0
  const pc = ((n % 12) + 12) % 12
  return Math.floor(n / 12) * 7 + WHITE_IN_OCTAVE[pc]
}

export function parseMidi(data: Uint8Array | ArrayBuffer, fileName = ''): Song {
  const midi = new Midi(data)
  const ppq = midi.header.ppq || 480
  const signatures = readSignatures(midi)
  const tempos = readTempos(midi)

  const tracks: SongTrack[] = []
  const raw: {
    midi: number
    time: number
    duration: number
    ticks: number
    durationTicks: number
    velocity: number
    track: number
  }[] = []

  midi.tracks.forEach((track, index) => {
    const drums = track.channel === 9 || track.instrument?.percussion === true
    const notes = track.notes
    if (!notes.length || drums) return
    let pitchSum = 0
    const trackIndex = tracks.length
    for (const note of notes) {
      pitchSum += note.midi
      raw.push({
        midi: note.midi,
        time: note.time,
        duration: Math.max(0.05, note.duration),
        ticks: note.ticks,
        durationTicks: Math.max(1, note.durationTicks),
        velocity: note.velocity,
        track: trackIndex,
      })
    }
    const name = track.name?.trim() || `Дорожка ${index + 1}`
    tracks.push({
      index: trackIndex,
      name,
      drums: false,
      noteCount: notes.length,
      avgPitch: pitchSum / notes.length,
      hand: 'R',
    })
  })

  const splitMode = assignTracks(tracks)
  const lastTick = raw.reduce((max, note) => Math.max(max, note.ticks + note.durationTicks), ppq * 4)
  const toSec = (tick: number) => secondsAt(tempos, ppq, tick)
  const bars = buildBars(signatures, lastTick, ppq, toSec)
  const notes: SongNote[] = raw.map((note, id) => ({
    id,
    midi: note.midi,
    time: note.time,
    duration: note.duration,
    end: note.time + note.duration,
    ticks: note.ticks,
    velocity: note.velocity,
    track: note.track,
    hand: 'R',
    bar: barNumberAtTick(bars, note.ticks),
    hit: false,
  }))
  notes.sort((a, b) => a.time - b.time || a.midi - b.midi)

  const song: Song = {
    name: cleanName(fileName) || midi.header.name || midi.name || 'MIDI',
    notes,
    chords: [],
    bars,
    tempos,
    tracks,
    ppq,
    lastTick,
    fileSignatures: signatures,
    meterOverride: '',
    splitMode,
    splitPitch: 60,
    duration: bars.length ? bars[bars.length - 1].endSec : midi.duration,
    maxDuration: 0.2,
  }
  for (const note of notes) if (note.duration > song.maxDuration) song.maxDuration = note.duration
  if (notes.length) {
    const end = notes.reduce((max, note) => Math.max(max, note.end), 0)
    if (end > song.duration) song.duration = end
  }
  applyHands(song)
  song.chords = buildChords(notes)
  return song
}

function cleanName(fileName: string): string {
  return fileName.replace(/^.*[\\/]/, '').replace(/\.(mid|midi)$/i, '').trim()
}

function assignTracks(tracks: SongTrack[]): 'pitch' | 'tracks' {
  const musical = tracks.filter((track) => track.noteCount > 0)
  if (musical.length < 2) return 'pitch'
  const min = Math.min(...musical.map((track) => track.avgPitch))
  const max = Math.max(...musical.map((track) => track.avgPitch))
  const mid = (min + max) / 2
  let lowClaimed = false
  for (const track of musical) {
    if (track.avgPitch < mid || (track.avgPitch === mid && !lowClaimed)) {
      track.hand = 'L'
      lowClaimed = true
    } else {
      track.hand = 'R'
    }
  }
  return 'tracks'
}

interface Signature {
  ticks: number
  num: number
  den: number
}

function readSignatures(midi: Midi): Signature[] {
  const raw = midi.header.timeSignatures.map((sig) => ({
    ticks: Math.max(0, sig.ticks | 0),
    num: sig.timeSignature?.[0] || 4,
    den: sig.timeSignature?.[1] || 4,
  }))
  raw.sort((a, b) => a.ticks - b.ticks)
  const out: Signature[] = []
  for (const sig of raw) {
    const next = { ticks: sig.ticks, num: clampCount(sig.num), den: validDen(sig.den) }
    const last = out[out.length - 1]
    if (last && last.ticks === next.ticks) {
      last.num = next.num
      last.den = next.den
    } else {
      out.push(next)
    }
  }
  if (!out.length || out[0].ticks !== 0) out.unshift({ ticks: 0, num: 4, den: 4 })
  return out
}

function readTempos(midi: Midi): TempoMark[] {
  const marks = midi.header.tempos
    .map((mark) => ({
      ticks: mark.ticks | 0,
      time: mark.time ?? midi.header.ticksToSeconds(mark.ticks),
      bpm: mark.bpm,
    }))
    .filter((mark) => Number.isFinite(mark.time) && Number.isFinite(mark.bpm) && mark.bpm > 0)
    .sort((a, b) => a.time - b.time)
  const out: TempoMark[] = []
  for (const mark of marks) {
    const last = out[out.length - 1]
    if (last && Math.abs(last.time - mark.time) < 0.0005) {
      last.bpm = mark.bpm
      last.ticks = mark.ticks
    } else out.push({ ticks: mark.ticks, time: mark.time, bpm: mark.bpm })
  }
  if (!out.length) out.push({ ticks: 0, time: 0, bpm: 120 })
  return out
}

function buildBars(
  signatures: Signature[],
  lastTick: number,
  ppq: number,
  toSec: (tick: number) => number,
): Bar[] {
  const bars: Bar[] = []
  let number = 1
  const musicEnd = Math.max(lastTick, ppq)
  for (let i = 0; i < signatures.length; i++) {
    const sig = signatures[i]
    const ticksPerBar = Math.max(1, Math.round((ppq * 4 * sig.num) / sig.den))
    const unit = Math.max(1, Math.round((ppq * 4) / sig.den))
    const nextTick = i + 1 < signatures.length ? signatures[i + 1].ticks : Number.POSITIVE_INFINITY
    const span = Math.max(ticksPerBar, Math.min(nextTick, musicEnd) - sig.ticks)
    const whole = Math.max(1, Math.ceil(span / ticksPerBar - 1e-6))
    const regionEnd = Math.min(nextTick, sig.ticks + whole * ticksPerBar)
    for (let startTick = sig.ticks; startTick < regionEnd - 0.5 && bars.length < 20000; startTick += ticksPerBar) {
      const endTick = Math.min(startTick + ticksPerBar, regionEnd)
      if (endTick <= startTick) break
      const beatSec: number[] = []
      for (let tick = startTick + unit; tick < endTick - unit * 0.2; tick += unit) {
        beatSec.push(toSec(tick))
      }
      bars.push({
        number: number++,
        startTick,
        endTick,
        startSec: toSec(startTick),
        endSec: toSec(endTick),
        num: sig.num,
        den: sig.den,
        beatSec,
      })
    }
  }
  if (!bars.length) {
    const endTick = ppq * 4
    bars.push({
      number: 1,
      startTick: 0,
      endTick,
      startSec: 0,
      endSec: toSec(endTick),
      num: 4,
      den: 4,
      beatSec: [1, 2, 3].map((beat) => toSec(ppq * beat)),
    })
  }
  return bars
}

function secondsAt(tempos: TempoMark[], ppq: number, tick: number): number {
  const beat = ppq || 480
  let bpm = 120
  let baseTick = 0
  let baseTime = 0
  for (let i = 0; i < tempos.length; i++) {
    if (tempos[i].ticks > tick) break
    bpm = tempos[i].bpm
    baseTick = tempos[i].ticks
    baseTime = tempos[i].time
  }
  return baseTime + (60 / bpm) * ((tick - baseTick) / beat)
}

export function fileMeterLabel(song: Song): string {
  const parts: string[] = []
  for (const sig of song.fileSignatures) {
    const label = `${sig.num}/${sig.den}`
    if (parts[parts.length - 1] !== label) parts.push(label)
  }
  return parts.join(' → ') || '4/4'
}

/** Пустая строка возвращает размер файла. «3/4» пересчитывает все такты с начала. */
export function setMeter(song: Song, value: string) {
  const chosen = parseMeter(value)
  song.meterOverride = chosen ? `${chosen.num}/${chosen.den}` : ''
  const signatures = chosen ? [{ ticks: 0, num: chosen.num, den: chosen.den }] : song.fileSignatures
  song.bars = buildBars(signatures, song.lastTick, song.ppq, (tick) => secondsAt(song.tempos, song.ppq, tick))
  for (const note of song.notes) note.bar = barNumberAtTick(song.bars, note.ticks)
  const barEnd = song.bars.length ? song.bars[song.bars.length - 1].endSec : 0
  let noteEnd = 0
  for (const note of song.notes) if (note.end > noteEnd) noteEnd = note.end
  song.duration = Math.max(barEnd, noteEnd)
}

function parseMeter(value: string): { num: number; den: number } | null {
  const match = /^(\d+)\s*\/\s*(\d+)$/.exec(value.trim())
  if (!match) return null
  return { num: clampCount(Number(match[1])), den: validDen(Number(match[2])) }
}

const DENS = [1, 2, 4, 8, 16, 32]

function validDen(den: number): number {
  const value = den | 0
  return DENS.includes(value) ? value : 4
}

function clampCount(num: number): number {
  const value = num | 0
  if (value < 1) return 4
  return Math.min(32, value)
}

export function tempoAt(song: Song, time: number): number {
  const marks = song.tempos
  if (!marks.length) return 120
  let bpm = marks[0].bpm
  for (let i = 0; i < marks.length; i++) {
    if (marks[i].time <= time + 0.001) bpm = marks[i].bpm
    else break
  }
  return bpm
}

export function meterAt(song: Song, barNumber: number): string {
  const bar = song.bars[barNumber - 1] ?? song.bars[0]
  if (!bar) return '4/4'
  return `${bar.num}/${bar.den}`
}

function barNumberAtTick(bars: Bar[], tick: number): number {
  let answer = 1
  for (const bar of bars) {
    if (bar.startTick <= tick) answer = bar.number
    else break
  }
  return answer
}

function buildChords(notes: SongNote[]): Chord[] {
  const ordered = [...notes].sort((a, b) => a.ticks - b.ticks || a.midi - b.midi)
  const chords: Chord[] = []
  for (const note of ordered) {
    const last = chords[chords.length - 1]
    if (last && last.ticks === note.ticks) {
      last.notes.push(note)
      if (note.time < last.time) last.time = note.time
    } else {
      chords.push({ ticks: note.ticks, time: note.time, notes: [note] })
    }
  }
  return chords
}

export function applyHands(song: Song) {
  for (const note of song.notes) {
    const track = song.tracks[note.track]
    if (song.splitMode === 'pitch') note.hand = note.midi < song.splitPitch ? 'L' : 'R'
    else note.hand = track?.hand === 'L' ? 'L' : 'R'
  }
}

export function setTrackHand(song: Song, index: number, hand: TrackHand) {
  const track = song.tracks[index]
  if (!track) return
  track.hand = hand
  applyHands(song)
}

export function setSplitPitch(song: Song, pitch: number) {
  song.splitPitch = pitch
  applyHands(song)
}

export function barAtTime(song: Song, time: number): number {
  const bars = song.bars
  if (!bars.length) return 1
  let answer = bars[0].number
  let lo = 0
  let hi = bars.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (bars[mid].startSec <= time + 0.0005) {
      answer = bars[mid].number
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return answer
}

export function loopBounds(song: Song, from: number, to: number): { start: number; end: number } {
  const startBar = song.bars[Math.min(from, to) - 1] ?? song.bars[0]
  const endBar = song.bars[Math.max(from, to) - 1] ?? song.bars[song.bars.length - 1]
  return {
    start: startBar?.startSec ?? 0,
    end: endBar?.endSec ?? song.duration,
  }
}
