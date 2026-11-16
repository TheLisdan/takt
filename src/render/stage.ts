import type { Transport } from '../engine/transport'
import {
  barAtTime,
  isBlack,
  loopBounds,
  pitchName,
  pitchNameRu,
  whiteIndex,
  type Song,
  type SongNote,
} from '../midi/parse'
import type { HandMode } from '../engine/transport'

const WINDOW_SEC = 3.4
const LEFT = '#4d8dff'
const RIGHT = '#2fce7a'
const LEFT_ON = '#eaf2ff'
const RIGHT_ON = '#e7fff3'
const LEFT_KEY = LEFT
const RIGHT_KEY = RIGHT
const LEFT_GHOST = 'rgba(77,141,255,0.62)'
const RIGHT_GHOST = 'rgba(47,206,122,0.62)'
const PRESS_KEY = 'rgba(255,214,140,0.96)'
const PRESS_CORE = 'rgba(255,255,255,0.9)'
/** Roland FA-06: 61 клавиша, от до2 до до7. */
const KEY_LO = 36
const KEY_HI = 96

interface Geom {
  cssW: number
  cssH: number
  rulerH: number
  keyboardH: number
  keyboardTop: number
  highwayH: number
  lo: number
  hi: number
  whiteW: number
  whiteCount: number
}

export interface StageHooks {
  onLoop: (from: number, to: number) => void
  onKey: (pitch: number, down: boolean) => void
  onDirty: () => void
}

export class Stage {
  private readonly ctx: CanvasRenderingContext2D
  private cssW = 0
  private cssH = 0
  private dpr = 1
  private geom: Geom | null = null
  private song: Song | null = null
  private keyCache: HTMLCanvasElement | null = null
  private keyStamp = ''
  private preview: { from: number; to: number } | null = null
  private anchor = 1
  private draggingRuler = false
  private mousePitch: number | null = null
  private readonly expectedIds = new Set<number>()

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly hooks: StageHooks,
  ) {
    const ctx = canvas.getContext('2d', { alpha: false })
    if (!ctx) throw new Error('Canvas недоступен')
    this.ctx = ctx
    canvas.addEventListener('pointerdown', (event) => this.onDown(event))
    canvas.addEventListener('pointermove', (event) => this.onMove(event))
    canvas.addEventListener('pointerup', (event) => this.onUp(event))
    canvas.addEventListener('pointercancel', (event) => this.onUp(event))
    canvas.addEventListener('contextmenu', (event) => event.preventDefault())
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect()
    const cssW = Math.max(1, rect.width)
    const cssH = Math.max(1, rect.height)
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5)
    const w = Math.round(cssW * dpr)
    const h = Math.round(cssH * dpr)
    this.cssW = cssW
    this.cssH = cssH
    this.dpr = dpr
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w
      this.canvas.height = h
      this.keyStamp = ''
    }
  }

  draw(transport: Transport, expected: SongNote[], now: number) {
    if (this.cssW < 2 || this.cssH < 2) this.resize()
    const ctx = this.ctx
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    const song = transport.song
    this.song = song
    const geom = layout(this.cssW, this.cssH)
    this.geom = geom
    ctx.fillStyle = '#0e1016'
    ctx.fillRect(0, 0, geom.cssW, geom.cssH)
    if (!song) {
      this.drawKeyboard(ctx, geom)
      ctx.fillStyle = '#c5ccda'
      ctx.font = '600 18px ui-sans-serif, system-ui, sans-serif'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText('Откройте MIDI или нажмите «Пример»', geom.cssW / 2, geom.keyboardTop / 2)
      ctx.font = '13px ui-sans-serif, system-ui, sans-serif'
      ctx.fillStyle = '#8b93a7'
      ctx.fillText('Потом выберите вход. Ждать — отдельная рука встаёт на каждой ноте.', geom.cssW / 2, geom.keyboardTop / 2 + 28)
      ctx.textAlign = 'left'
      return
    }

    this.drawRuler(ctx, geom, song, transport)
    ctx.save()
    ctx.beginPath()
    ctx.rect(0, geom.rulerH, geom.cssW, geom.highwayH)
    ctx.clip()
    this.drawHighway(ctx, geom, song, transport, expected, now)
    ctx.restore()
    ctx.fillStyle = 'rgba(255,255,255,0.92)'
    ctx.fillRect(0, geom.keyboardTop - 2, geom.cssW, 2)
    if (transport.waiting && expected.length) {
      this.drawWaitLabel(ctx, geom, expected)
    }
    this.drawKeyboard(ctx, geom)
    this.drawKeyOverlays(ctx, geom, song, transport, now)
  }

  private drawRuler(ctx: CanvasRenderingContext2D, geom: Geom, song: Song, transport: Transport) {
    ctx.fillStyle = '#141821'
    ctx.fillRect(0, 0, geom.cssW, geom.rulerH)
    const dur = song.duration || 1
    const region = this.preview ?? (transport.loopOn ? { from: transport.loopFrom, to: transport.loopTo } : null)
    if (region) {
      const bounds = loopBounds(song, region.from, region.to)
      const x1 = (bounds.start / dur) * geom.cssW
      const x2 = (bounds.end / dur) * geom.cssW
      ctx.fillStyle = 'rgba(226, 179, 64, 0.38)'
      ctx.fillRect(x1, 0, Math.max(3, x2 - x1), geom.rulerH)
    }
    const labelStep = geom.cssW / Math.max(1, song.bars.length) >= 22 ? 1 : 2
    ctx.font = '11px ui-sans-serif, system-ui, sans-serif'
    ctx.textBaseline = 'middle'
    ctx.textAlign = 'left'
    for (let i = 0; i < song.bars.length; i++) {
      const bar = song.bars[i]
      const x = (bar.startSec / dur) * geom.cssW
      ctx.fillStyle = 'rgba(255,255,255,0.16)'
      ctx.fillRect(x, 0, 1, geom.rulerH)
      if (i % labelStep === 0) {
        ctx.fillStyle = '#c5ccda'
        ctx.fillText(String(bar.number), x + 4, geom.rulerH / 2)
      }
    }
    const marker = Math.max(0, Math.min(dur, transport.time))
    ctx.fillStyle = '#ff5d73'
    ctx.fillRect((marker / dur) * geom.cssW - 1, 0, 2, geom.rulerH)
  }

  private drawHighway(
    ctx: CanvasRenderingContext2D,
    geom: Geom,
    song: Song,
    transport: Transport,
    expected: SongNote[],
    now: number,
  ) {
    const time = transport.time
    ctx.fillStyle = 'rgba(255,255,255,0.045)'
    const origin = whiteIndex(geom.lo)
    for (let midi = geom.lo; midi <= geom.hi; midi += 12) {
      const x = (whiteIndex(midi) - origin) * geom.whiteW
      ctx.fillRect(x, 0, geom.whiteW, geom.highwayH + geom.rulerH)
    }
    this.expectedIds.clear()
    for (let i = 0; i < expected.length; i++) this.expectedIds.add(expected[i].id)
    const bounds = transport.loopOn ? loopBounds(song, transport.loopFrom, transport.loopTo) : null
    ctx.font = '12px ui-sans-serif, system-ui, sans-serif'
    ctx.textBaseline = 'top'
    for (let i = 0; i < song.bars.length; i++) {
      const bar = song.bars[i]
      const compound = bar.num >= 6 && bar.num % 3 === 0
      for (let beat = 0; beat < bar.beatSec.length; beat++) {
        const at = bar.beatSec[beat]
        if (at < time - 0.05 || at > time + WINDOW_SEC) continue
        const strong = compound && (beat + 1) % 3 === 0
        ctx.fillStyle = strong ? 'rgba(255,255,255,0.16)' : 'rgba(255,255,255,0.055)'
        ctx.fillRect(0, yAt(geom, time, at), geom.cssW, 1)
      }
      if (bar.startSec < time - 0.05 || bar.startSec > time + WINDOW_SEC) continue
      const y = yAt(geom, time, bar.startSec)
      ctx.fillStyle = 'rgba(255,255,255,0.22)'
      ctx.fillRect(0, y, geom.cssW, 1)
      const prev = song.bars[i - 1]
      const changed = !prev || prev.num !== bar.num || prev.den !== bar.den
      ctx.fillStyle = '#8b93a7'
      ctx.fillText(changed ? `${bar.number}  ${bar.num}/${bar.den}` : String(bar.number), 8, y + 4)
    }
    if (bounds) {
      ctx.fillStyle = 'rgba(226, 179, 64, 0.9)'
      for (const at of [bounds.start, bounds.end]) {
        if (at < time - 0.05 || at > time + WINDOW_SEC) continue
        ctx.fillRect(0, yAt(geom, time, at), geom.cssW, 2)
      }
    }
    this.paintNotes(ctx, geom, song, transport.hand, time, bounds, 'ghost')
    this.paintNotes(ctx, geom, song, transport.hand, time, bounds, 'active')
    if (transport.waiting) {
      const pulse = 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(now / 150))
      ctx.strokeStyle = `rgba(255, 224, 138, ${pulse})`
      ctx.lineWidth = 2
      for (let i = 0; i < expected.length; i++) {
        const box = placed(expected[i], geom, time)
        if (!box) continue
        ctx.strokeRect(box.x + 1, box.y + 1, box.w - 2, box.h - 2)
      }
    }
  }

  private paintNotes(
    ctx: CanvasRenderingContext2D,
    geom: Geom,
    song: Song,
    hand: HandMode,
    time: number,
    bounds: { start: number; end: number } | null,
    pass: 'ghost' | 'active',
  ) {
    const notes = song.notes
    const from = lowerBound(notes, time - song.maxDuration)
    const horizon = time + WINDOW_SEC
    ctx.textAlign = 'left'
    ctx.textBaseline = 'alphabetic'
    ctx.font = '600 11px ui-sans-serif, system-ui, sans-serif'
    for (let i = from; i < notes.length; i++) {
      const note = notes[i]
      if (note.time > horizon) break
      if (note.end < time) continue
      if (bounds && (note.time < bounds.start - 0.0005 || note.time >= bounds.end - 0.0005)) continue
      const role = noteRole(song, note, hand)
      if (role !== pass) continue
      const box = placed(note, geom, time)
      if (!box) continue
      const waiting = pass === 'active' && this.expectedIds.has(note.id)
      const playing = note.time <= time + 0.0005 && note.end > time
      const body = pass === 'ghost' ? 0.4 : note.hit && !waiting && !playing ? 0.5 : 1
      ctx.globalAlpha = body
      ctx.fillStyle = note.hand === 'L' ? LEFT : RIGHT
      ctx.fillRect(box.x, box.y, box.w, box.h)
      if (playing) {
        ctx.globalAlpha = pass === 'ghost' ? 0.55 : 1
        ctx.fillStyle = note.hand === 'L' ? LEFT_ON : RIGHT_ON
        ctx.fillRect(box.x, box.y, box.w, box.h)
      }
      if (pass === 'active' && box.w > 14 && box.h > 13 && note.time - time < 1.5 && note.time - time > -0.15) {
        ctx.globalAlpha = 0.9
        ctx.fillStyle = '#08110d'
        ctx.fillText(pitchName(note.midi), box.x + 3, Math.min(box.y + box.h - 4, box.y + 13))
      }
    }
    ctx.globalAlpha = 1
  }

  private drawWaitLabel(ctx: CanvasRenderingContext2D, geom: Geom, expected: SongNote[]) {
    const text = 'Жду  ' + expected.map((note) => pitchNameRu(note.midi)).join('  +  ')
    ctx.font = '600 14px ui-sans-serif, system-ui, sans-serif'
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    const width = ctx.measureText(text).width
    const y = geom.keyboardTop - 28
    ctx.fillStyle = 'rgba(10, 12, 18, 0.88)'
    ctx.fillRect(8, y - 12, width + 18, 24)
    ctx.fillStyle = '#ffe08a'
    ctx.fillText(text, 16, y)
  }

  private drawKeyboard(ctx: CanvasRenderingContext2D, geom: Geom) {
    const stamp = `${geom.cssW}x${geom.keyboardH}:${geom.lo}-${geom.hi}:${this.dpr}`
    if (stamp !== this.keyStamp || !this.keyCache) {
      this.keyCache = paintKeyboard(geom, this.dpr)
      this.keyStamp = stamp
    }
    ctx.drawImage(this.keyCache, 0, geom.keyboardTop, geom.cssW, geom.keyboardH)
  }

  private drawKeyOverlays(
    ctx: CanvasRenderingContext2D,
    geom: Geom,
    song: Song,
    transport: Transport,
    now: number,
  ) {
    const lights = new Map<number, KeyLight>()
    this.collectPlaying(lights, geom, song, transport)
    for (const pitch of transport.held) {
      if (pitch < geom.lo || pitch > geom.hi) continue
      const sounding = lights.get(pitch)
      if (sounding) sounding.pressed = true
      else lights.set(pitch, { color: PRESS_KEY, pressed: false })
    }
    for (const [pitch, until] of transport.wrongUntil) {
      if (until <= now || pitch < geom.lo || pitch > geom.hi) continue
      lights.set(pitch, { color: 'rgba(255,70,70,0.94)', pressed: false })
    }
    for (const [midi, light] of lights) {
      if (!isBlack(midi)) paintLitKey(ctx, geom, midi, light)
    }
    if (lights.size) redrawBlackKeys(ctx, geom)
    for (const [midi, light] of lights) {
      if (isBlack(midi)) paintLitKey(ctx, geom, midi, light)
    }
  }

  private collectPlaying(
    lights: Map<number, KeyLight>,
    geom: Geom,
    song: Song,
    transport: Transport,
  ) {
    const time = transport.time
    const bounds = transport.loopOn ? loopBounds(song, transport.loopFrom, transport.loopTo) : null
    const notes = song.notes
    const from = lowerBound(notes, time - song.maxDuration)
    for (let i = from; i < notes.length; i++) {
      const note = notes[i]
      if (note.time > time + 0.0005) break
      if (note.end <= time) continue
      if (note.midi < geom.lo || note.midi > geom.hi) continue
      if (bounds && (note.time < bounds.start - 0.0005 || note.time >= bounds.end - 0.0005)) continue
      const role = noteRole(song, note, transport.hand)
      if (role === 'hidden') continue
      const prev = lights.get(note.midi)
      const color = role === 'ghost'
        ? note.hand === 'L' ? LEFT_GHOST : RIGHT_GHOST
        : note.hand === 'L' ? LEFT_KEY : RIGHT_KEY
      if (prev && role === 'ghost') continue
      lights.set(note.midi, { color, pressed: prev?.pressed ?? false })
    }
  }

  private onDown(event: PointerEvent) {
    if (!this.geom) return
    try {
      this.canvas.setPointerCapture(event.pointerId)
    } catch {
      /* The event can be untrusted; the drag still tracks pointermove. */
    }
    const { x, y } = localPoint(this.canvas, event)
    if (y <= this.geom.rulerH && this.song && this.song.duration > 0) {
      const bar = barAtTime(this.song, (x / this.cssW) * this.song.duration)
      this.anchor = bar
      this.preview = { from: bar, to: bar }
      this.draggingRuler = true
      this.hooks.onDirty()
      return
    }
    const pitch = this.pitchAt(x, y)
    if (pitch != null) {
      this.mousePitch = pitch
      this.hooks.onKey(pitch, true)
    }
  }

  private onMove(event: PointerEvent) {
    if (!this.geom) return
    const { x, y } = localPoint(this.canvas, event)
    this.canvas.style.cursor = y <= this.geom.rulerH ? 'ew-resize' : y >= this.geom.keyboardTop ? 'pointer' : 'default'
    if (this.draggingRuler && this.song && this.song.duration > 0) {
      const bar = barAtTime(this.song, clamp(x / this.cssW, 0, 0.9999) * this.song.duration)
      const from = Math.min(this.anchor, bar)
      const to = Math.max(this.anchor, bar)
      if (!this.preview || this.preview.from !== from || this.preview.to !== to) {
        this.preview = { from, to }
        this.hooks.onDirty()
      }
      return
    }
    if (this.mousePitch == null) return
    const pitch = this.pitchAt(x, y)
    if (pitch === this.mousePitch) return
    this.hooks.onKey(this.mousePitch, false)
    this.mousePitch = pitch
    if (pitch != null) this.hooks.onKey(pitch, true)
  }

  private onUp(event: PointerEvent) {
    if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId)
    if (this.draggingRuler && this.preview) {
      const { from, to } = this.preview
      this.preview = null
      this.draggingRuler = false
      this.hooks.onLoop(from, to)
    }
    if (this.mousePitch != null) {
      this.hooks.onKey(this.mousePitch, false)
      this.mousePitch = null
    }
  }

  private pitchAt(x: number, y: number): number | null {
    const geom = this.geom
    if (!geom || y < geom.keyboardTop || x < 0 || x > geom.cssW) return null
    if (y - geom.keyboardTop <= geom.keyboardH * 0.62) {
      const width = geom.whiteW * 0.62
      for (let midi = geom.hi; midi >= geom.lo; midi--) {
        if (!isBlack(midi)) continue
        const center = (whiteIndex(midi) - whiteIndex(geom.lo) + 1) * geom.whiteW
        if (x >= center - width / 2 && x <= center + width / 2) return midi
      }
    }
    const index = Math.floor(x / geom.whiteW)
    if (index < 0 || index >= geom.whiteCount) return null
    return midiOfWhite(geom.lo, index)
  }
}

function layout(cssW: number, cssH: number): Geom {
  const rulerH = cssH < 300 ? 28 : 36
  const keyboardH = Math.min(132, Math.max(84, cssH * 0.22))
  const keyboardTop = cssH - keyboardH
  const whiteCount = whiteIndex(KEY_HI) - whiteIndex(KEY_LO) + 1
  return {
    cssW,
    cssH,
    rulerH,
    keyboardH,
    keyboardTop,
    highwayH: Math.max(40, keyboardTop - rulerH),
    lo: KEY_LO,
    hi: KEY_HI,
    whiteW: cssW / whiteCount,
    whiteCount,
  }
}

function yAt(geom: Geom, time: number, songTime: number): number {
  return geom.keyboardTop - ((songTime - time) / WINDOW_SEC) * geom.highwayH
}

function placed(note: SongNote, geom: Geom, time: number): { x: number; y: number; w: number; h: number } | null {
  let top = yAt(geom, time, note.end)
  const bottom = yAt(geom, time, note.time)
  if (bottom - top < 8) top = bottom - 8
  if (bottom < geom.rulerH || top > geom.keyboardTop) return null
  const box = noteBox(note.midi, geom)
  return { x: box.x, y: top, w: box.w, h: bottom - top }
}

function noteBox(midi: number, geom: Geom): { x: number; w: number } {
  if (isBlack(midi)) {
    const w = geom.whiteW * 0.56
    const center = (whiteIndex(midi) - whiteIndex(geom.lo) + 1) * geom.whiteW
    return { x: center - w / 2, w }
  }
  const w = Math.max(4, geom.whiteW * 0.88)
  const center = (whiteIndex(midi) - whiteIndex(geom.lo)) * geom.whiteW + geom.whiteW / 2
  return { x: center - w / 2, w }
}

function noteRole(song: Song, note: SongNote, hand: HandMode): 'hidden' | 'ghost' | 'active' {
  const track = song.tracks[note.track]
  if (!track || track.hand === 'off') return 'hidden'
  if (hand === 'both') return 'active'
  return note.hand === hand ? 'active' : 'ghost'
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

function paintKeyboard(geom: Geom, dpr: number): HTMLCanvasElement {
  const cache = document.createElement('canvas')
  cache.width = Math.max(1, Math.round(geom.cssW * dpr))
  cache.height = Math.max(1, Math.round(geom.keyboardH * dpr))
  const ctx = cache.getContext('2d')
  if (!ctx) return cache
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.fillStyle = '#b9b4aa'
  ctx.fillRect(0, 0, geom.cssW, geom.keyboardH)
  ctx.font = '11px ui-sans-serif, system-ui, sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'bottom'
  const loWhite = whiteIndex(geom.lo)
  for (let i = 0; i < geom.whiteCount; i++) {
    const midi = midiOfWhite(geom.lo, i)
    const x = i * geom.whiteW
    ctx.fillStyle = '#f4f1ea'
    ctx.fillRect(x + 0.5, 0, geom.whiteW - 1, geom.keyboardH)
    if (midi % 12 === 0 && geom.whiteW >= 16) {
      ctx.fillStyle = '#5c615c'
      ctx.fillText(pitchName(midi), x + geom.whiteW / 2, geom.keyboardH - 6)
    }
  }
  const blackH = geom.keyboardH * 0.62
  const blackW = geom.whiteW * 0.62
  ctx.fillStyle = '#14171d'
  for (let midi = geom.lo; midi <= geom.hi; midi++) {
    if (!isBlack(midi)) continue
    const center = (whiteIndex(midi) - loWhite + 1) * geom.whiteW
    ctx.fillRect(center - blackW / 2, 0, blackW, blackH)
  }
  return cache
}

interface KeyLight {
  color: string
  pressed: boolean
}

function keyRect(geom: Geom, midi: number): { x: number; y: number; w: number; h: number } {
  if (isBlack(midi)) {
    const width = geom.whiteW * 0.62
    const center = (whiteIndex(midi) - whiteIndex(geom.lo) + 1) * geom.whiteW
    return { x: center - width / 2, y: geom.keyboardTop, w: width, h: geom.keyboardH * 0.62 }
  }
  const x = (whiteIndex(midi) - whiteIndex(geom.lo)) * geom.whiteW
  return { x: x + 1, y: geom.keyboardTop, w: geom.whiteW - 2, h: geom.keyboardH }
}

function paintLitKey(ctx: CanvasRenderingContext2D, geom: Geom, midi: number, light: KeyLight) {
  const box = keyRect(geom, midi)
  ctx.fillStyle = light.color
  ctx.fillRect(box.x, box.y, box.w, box.h)
  const lip = Math.max(3, box.h * (isBlack(midi) ? 0.12 : 0.1))
  ctx.fillStyle = 'rgba(255,255,255,0.38)'
  ctx.fillRect(box.x, box.y, box.w, lip)
  const shade = Math.max(5, box.h * 0.2)
  ctx.fillStyle = 'rgba(0,0,0,0.3)'
  ctx.fillRect(box.x, box.y + box.h - shade, box.w, shade)
  if (!light.pressed) return
  const insetX = Math.max(2, box.w * 0.2)
  const coreH = box.h * 0.34
  ctx.fillStyle = PRESS_CORE
  ctx.fillRect(box.x + insetX, box.y + box.h * 0.3, Math.max(1, box.w - insetX * 2), coreH)
}

function redrawBlackKeys(ctx: CanvasRenderingContext2D, geom: Geom) {
  const blackH = geom.keyboardH * 0.62
  const blackW = geom.whiteW * 0.62
  const origin = whiteIndex(geom.lo)
  ctx.fillStyle = '#14171d'
  for (let midi = geom.lo; midi <= geom.hi; midi++) {
    if (!isBlack(midi)) continue
    const center = (whiteIndex(midi) - origin + 1) * geom.whiteW
    ctx.fillRect(center - blackW / 2, geom.keyboardTop, blackW, blackH)
  }
}

function midiOfWhite(lo: number, index: number): number {
  let seen = 0
  for (let midi = lo; midi < 128; midi++) {
    if (isBlack(midi)) continue
    if (seen === index) return midi
    seen++
  }
  return lo
}

function localPoint(canvas: HTMLCanvasElement, event: PointerEvent): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect()
  return { x: event.clientX - rect.left, y: event.clientY - rect.top }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
