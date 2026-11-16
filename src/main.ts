import { Preview } from './audio/preview'
import { waitingLabel, Transport, type HandMode, type PlayMode } from './engine/transport'
import { MidiIn } from './midi/input'
import {
  fileMeterLabel,
  meterAt,
  parseMidi,
  setMeter,
  pitchNameRu,
  setSplitPitch,
  setTrackHand,
  tempoAt,
  type Song,
  type SongNote,
  type TrackHand,
} from './midi/parse'
import { exampleMidi } from './midi/sample'
import { Stage } from './render/stage'

const fileInput = must<HTMLInputElement>('file')
const sampleButton = must<HTMLButtonElement>('sample')
const deviceSelect = must<HTMLSelectElement>('device')
const outputSelect = must<HTMLSelectElement>('output')
const midiButton = must<HTMLButtonElement>('midi')
const hands = must<HTMLDivElement>('hands')
const modes = must<HTMLDivElement>('modes')
const playButton = must<HTMLButtonElement>('play')
const speedInput = must<HTMLInputElement>('speed')
const speedValue = must<HTMLSpanElement>('speed-value')
const meterSelect = must<HTMLSelectElement>('meter')
const barFrom = must<HTMLInputElement>('bar-from')
const barTo = must<HTMLInputElement>('bar-to')
const loopButton = must<HTMLButtonElement>('loop')
const splitWrap = must<HTMLLabelElement>('split-wrap')
const splitInput = must<HTMLInputElement>('split')
const splitName = must<HTMLSpanElement>('split-name')
const tracksEl = must<HTMLDivElement>('tracks')
const statusEl = must<HTMLParagraphElement>('status')
const canvas = must<HTMLCanvasElement>('stage')

const transport = new Transport()
const midi = new MidiIn()
const preview = new Preview(midi)
const expected: SongNote[] = []
let dirty = true

const stage = new Stage(canvas, {
  onLoop: (from, to) => {
    barFrom.value = String(from)
    barTo.value = String(to)
    transport.engageLoop(from, to)
    dirty = true
  },
  onKey: (pitch, down) => {
    if (down) transport.noteOn(pitch, performance.now())
    else transport.noteOff(pitch)
    dirty = true
  },
  onDirty: () => {
    dirty = true
  },
})

midi.setHandler((pitch, _velocity, down) => {
  if (down) transport.noteOn(pitch, performance.now())
  else transport.noteOff(pitch)
  dirty = true
})

midi.onDevices = () => fillDevices()

sampleButton.addEventListener('click', () => {
  load(parseMidi(exampleMidi('hands'), 'Пример'))
})

fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0]
  fileInput.value = ''
  if (!file) return
  try {
    const bytes = new Uint8Array(await file.arrayBuffer())
    const song = parseMidi(bytes, file.name)
    if (!song.notes.length) {
      statusEl.textContent = 'В файле нет нот.'
      return
    }
    load(song)
  } catch {
    statusEl.textContent = 'Не получилось прочитать MIDI.'
  }
})

midiButton.addEventListener('click', async () => {
  midiButton.disabled = true
  const error = await midi.connect()
  midiButton.disabled = false
  if (error) {
    statusEl.textContent = error
    return
  }
  setLabel(midiButton, 'MIDI готово')
  fillDevices()
})

deviceSelect.addEventListener('change', () => {
  if (deviceSelect.value) midi.select(deviceSelect.value)
})

outputSelect.addEventListener('change', () => {
  preview.halt()
  midi.selectOutput(outputSelect.value || null)
  dirty = true
})

hands.addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest('button')
  const hand = button?.dataset.hand as HandMode | undefined
  if (!button || (hand !== 'L' && hand !== 'R' && hand !== 'both')) return
  transport.setHand(hand)
  pressOnly(hands, button)
  dirty = true
})

modes.addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest('button')
  const mode = button?.dataset.mode as PlayMode | undefined
  if (!button || (mode !== 'wait' && mode !== 'listen')) return
  transport.setMode(mode)
  if (mode === 'listen') preview.unlock()
  else preview.halt()
  pressOnly(modes, button)
  dirty = true
})

playButton.addEventListener('click', () => {
  if (!transport.playing) preview.unlock()
  transport.togglePlay()
  if (!transport.playing) preview.halt()
  dirty = true
})

speedInput.addEventListener('input', () => {
  transport.setSpeed(Number(speedInput.value) / 100)
  if (!transport.song) speedValue.textContent = `${speedInput.value}%`
  dirty = true
})

meterSelect.addEventListener('change', () => {
  const song = transport.song
  if (!song) return
  const oldMax = Number(barTo.max) || song.bars.length
  const from = Number(barFrom.value)
  const to = Number(barTo.value)
  const coveredAll = from <= 1 && to >= oldMax
  setMeter(song, meterSelect.value)
  const max = Math.max(1, song.bars.length)
  barFrom.max = String(max)
  barTo.max = String(max)
  const nextFrom = clamp(from, 1, max)
  const nextTo = coveredAll ? max : clamp(Math.max(to, nextFrom), 1, max)
  barFrom.value = String(nextFrom)
  barTo.value = String(nextTo)
  if (transport.loopOn) transport.engageLoop(nextFrom, nextTo)
  dirty = true
})

loopButton.addEventListener('click', () => {
  if (!transport.song) return
  if (transport.loopOn) transport.disableLoop()
  else {
    const range = readBars()
    transport.engageLoop(range.from, range.to)
  }
  dirty = true
})

barFrom.addEventListener('change', onBarsChanged)
barTo.addEventListener('change', onBarsChanged)

canvas.addEventListener('wheel', (event) => {
  if (!transport.song || event.ctrlKey) return
  event.preventDefault()
  let dy = event.deltaY || event.deltaX
  if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) dy *= 16
  else if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) dy *= canvas.clientHeight
  if (!dy) return
  preview.halt()
  transport.seekBy(clamp(dy * 0.01, -2.5, 2.5))
  dirty = true
}, { passive: false })

splitInput.addEventListener('input', () => {
  const song = transport.song
  if (!song) return
  const pitch = Number(splitInput.value)
  setSplitPitch(song, pitch)
  splitName.textContent = pitchNameRu(pitch)
  transport.refreshGates()
  dirty = true
})

window.addEventListener('keydown', (event) => {
  if (event.code !== 'Space') return
  const tag = (event.target as HTMLElement | null)?.tagName
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return
  event.preventDefault()
  if (!transport.playing) preview.unlock()
  transport.togglePlay()
  if (!transport.playing) preview.halt()
  dirty = true
})

window.addEventListener('pagehide', () => {
  preview.halt()
  midi.silenceOutput()
})

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') preview.halt()
})

const wrap = canvas.parentElement
if (wrap) {
  new ResizeObserver(() => {
    stage.resize()
    dirty = true
  }).observe(wrap)
}
stage.resize()

function load(song: Song) {
  preview.halt()
  transport.setSong(song)
  const bars = Math.max(1, song.bars.length)
  barFrom.max = String(bars)
  barTo.max = String(bars)
  barFrom.value = '1'
  barTo.value = String(bars)
  meterSelect.value = ''
  const fileOption = meterSelect.querySelector('option[value=""]')
  if (fileOption) fileOption.textContent = `файл · ${fileMeterLabel(song)}`
  splitInput.value = String(song.splitPitch)
  splitName.textContent = pitchNameRu(song.splitPitch)
  splitWrap.hidden = song.splitMode !== 'pitch'
  renderTracks(song)
  dirty = true
  sync()
}

function renderTracks(song: Song) {
  tracksEl.replaceChildren()
  if (song.splitMode !== 'tracks') return
  for (const track of song.tracks) {
    const row = document.createElement('div')
    row.className = 'track'
    const label = document.createElement('span')
    label.textContent = `${trackTitle(track.name)} · ${track.noteCount}`
    row.append(label)
    const handsForTrack: TrackHand[] = ['L', 'R', 'off']
    for (const hand of handsForTrack) {
      const button = document.createElement('button')
      button.type = 'button'
      button.dataset.track = String(track.index)
      button.dataset.hand = hand
      button.textContent = hand === 'L' ? 'Л' : hand === 'R' ? 'П' : 'Скрыть'
      button.setAttribute('aria-pressed', String(track.hand === hand))
      button.addEventListener('click', () => {
        setTrackHand(song, track.index, hand)
        transport.refreshGates()
        paintTracks(song)
        dirty = true
      })
      row.append(button)
    }
    tracksEl.append(row)
  }
}

function paintTracks(song: Song) {
  for (const button of tracksEl.querySelectorAll('button')) {
    const index = Number(button.dataset.track)
    button.setAttribute('aria-pressed', String(song.tracks[index]?.hand === button.dataset.hand))
  }
}

function onBarsChanged() {
  if (!transport.song) return
  const range = readBars()
  if (transport.loopOn) transport.engageLoop(range.from, range.to)
  dirty = true
}

function readBars(): { from: number; to: number } {
  const max = transport.song?.bars.length ?? 1
  let from = clamp(Math.round(Number(barFrom.value) || 1), 1, max)
  let to = clamp(Math.round(Number(barTo.value) || 1), 1, max)
  if (from > to) {
    const swap = from
    from = to
    to = swap
  }
  barFrom.value = String(from)
  barTo.value = String(to)
  return { from, to }
}

function fillDevices() {
  const devices = midi.devices()
  const selected = midi.selectedId
  deviceSelect.replaceChildren()
  if (!devices.length) {
    const option = document.createElement('option')
    option.value = ''
    option.textContent = midi.connected ? 'Устройств нет' : 'Сначала подключите MIDI'
    deviceSelect.append(option)
    deviceSelect.disabled = true
    return
  }
  deviceSelect.disabled = false
  for (const device of devices) {
    const option = document.createElement('option')
    option.value = device.id
    option.textContent = device.name
    deviceSelect.append(option)
  }
  if (selected && devices.some((device) => device.id === selected)) deviceSelect.value = selected
  else if (devices[0]) {
    deviceSelect.value = devices[0].id
    midi.select(devices[0].id)
  }
  fillOutputs()
}

function fillOutputs() {
  const outputs = midi.outputs()
  const selected = midi.selectedOutputId
  outputSelect.replaceChildren()
  const browser = document.createElement('option')
  browser.value = ''
  browser.textContent = 'Звук браузера'
  outputSelect.append(browser)
  for (const output of outputs) {
    const option = document.createElement('option')
    option.value = output.id
    option.textContent = output.name
    outputSelect.append(option)
  }
  outputSelect.value = selected && outputs.some((output) => output.id === selected) ? selected : ''
}

function sync() {
  playButton.disabled = !transport.song
  playButton.dataset.state = transport.playing ? 'pause' : 'play'
  setLabel(playButton, transport.playing ? 'Пауза' : 'Старт')
  loopButton.setAttribute('aria-pressed', String(transport.loopOn))
  setLabel(loopButton, transport.loopOn ? 'Луп включён' : 'Зациклить')
  const song = transport.song
  if (!song) return
  const parts = [
    song.name,
    `такт ${transport.displayBar()} из ${song.bars.length}`,
    meterAt(song, transport.displayBar()),
    `${song.notes.length} нот`,
  ]
  const bpm = Math.round(tempoAt(song, Math.max(0, transport.time)) * transport.speed)
  const tempoText = `${bpm} BPM`
  if (speedValue.textContent !== tempoText) speedValue.textContent = tempoText
  if (transport.playing && transport.mode === 'wait' && transport.waiting) {
    const label = waitingLabel(expected)
    parts.push(label ? `жду ${label}` : 'жду ноту')
  } else if (transport.playing) {
    if (transport.mode === 'wait') parts.push('едет к ноте')
    else parts.push(transport.loopOn ? 'слушаю фрагмент' : 'слушаю')
  } else {
    parts.push('пауза')
  }
  parts.push(transport.hand === 'L' ? 'левая' : transport.hand === 'R' ? 'правая' : 'обе руки')
  parts.push(midi.outputName ? `выход ${midi.outputName}` : 'звук браузера')
  const text = parts.join(' · ')
  if (statusEl.textContent !== text) statusEl.textContent = text
}

function pressOnly(group: HTMLElement, active: HTMLButtonElement) {
  for (const button of group.querySelectorAll('button')) {
    button.setAttribute('aria-pressed', String(button === active))
  }
}

function frame(now: number) {
  transport.tick(now)
  preview.follow(transport)
  if (dirty || transport.playing || transport.wrongUntil.size > 0 || preview.activeNotes > 0) {
    expected.length = 0
    transport.fillExpected(expected)
    stage.draw(transport, expected, now)
    sync()
    dirty = false
  }
  requestAnimationFrame(frame)
}

requestAnimationFrame(frame)

if (import.meta.env.DEV) {
  window.__piano = {
    noteOn(pitch: number) {
      transport.noteOn(pitch, performance.now())
      dirty = true
    },
    noteOff(pitch: number) {
      transport.noteOff(pitch)
      dirty = true
    },
    transport,
    preview,
    loadExample(kind: 'hands' | 'single' = 'hands') {
      load(parseMidi(exampleMidi(kind), kind === 'single' ? 'Одна дорожка' : 'Пример'))
    },
  }
}

declare global {
  interface Window {
    __piano?: {
      noteOn: (pitch: number) => void
      noteOff: (pitch: number) => void
      transport: Transport
      preview: Preview
      loadExample: (kind?: 'hands' | 'single') => void
    }
  }
}

function trackTitle(name: string): string {
  if (name === 'Right') return 'Правая'
  if (name === 'Left') return 'Левая'
  return name
}

function setLabel(button: HTMLElement, text: string) {
  const label = button.querySelector('.lbl')
  if (label) label.textContent = text
}

function must<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id)
  if (!element) throw new Error(`Нет элемента #${id}`)
  return element as T
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
