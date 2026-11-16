interface Ev {
  tick: number
  order: number
  data: number[]
}

function vlq(value: number): number[] {
  let v = value >>> 0
  const bytes = [v & 0x7f]
  v >>= 7
  while (v > 0) {
    bytes.push((v & 0x7f) | 0x80)
    v >>= 7
  }
  return bytes.reverse()
}

function encodeTrack(events: Ev[]): Uint8Array {
  events.sort((a, b) => a.tick - b.tick || a.order - b.order)
  const body: number[] = []
  let last = 0
  for (const event of events) {
    body.push(...vlq(event.tick - last), ...event.data)
    last = event.tick
  }
  body.push(0x00, 0xff, 0x2f, 0x00)
  const out = new Uint8Array(8 + body.length)
  out.set([0x4d, 0x54, 0x72, 0x6b], 0)
  const len = body.length
  out[4] = (len >>> 24) & 255
  out[5] = (len >>> 16) & 255
  out[6] = (len >>> 8) & 255
  out[7] = len & 255
  out.set(body, 8)
  return out
}

function addNote(events: Ev[], tick: number, midi: number, dur: number, channel: number) {
  events.push({ tick, order: 2, data: [0x90 | channel, midi, 84] })
  events.push({ tick: tick + dur, order: 1, data: [0x80 | channel, midi, 0] })
}

const LEFT: number[][][] = [
  [[48], [52], [55], [52]],
  [[50], [53], [57], [53]],
  [[48, 55], [48, 55], [43, 50], [43, 50]],
  [[48], [47], [45], [48]],
  [[45], [48], [52], [48]],
  [[43], [47], [50], [47]],
  [[41, 48], [41, 48], [43, 50], [43, 50]],
  [[48], [52], [55], [48]],
]

const RIGHT: number[][][] = [
  [[64], [67], [72], [67]],
  [[65], [69], [74], [69]],
  [[64, 67], [64, 67], [62, 65], [62, 65]],
  [[72], [71], [69], [67]],
  [[64], [67], [69], [67]],
  [[62], [65], [69], [65]],
  [[60, 64], [60, 64], [62, 65], [62, 65]],
  [[67], [64], [60], [64]],
]

function metaName(text: string): number[] {
  const bytes = Array.from(text).map((ch) => ch.charCodeAt(0))
  return [0xff, 0x03, bytes.length, ...bytes]
}

/** Short original exercise: two hands, 8 bars, 120 bpm, 4/4. */
export function exampleMidi(kind: 'hands' | 'single' = 'hands'): Uint8Array {
  const ppq = 480
  const dur = ppq - 24
  const tempo: Ev = { tick: 0, order: -2, data: [0xff, 0x51, 0x03, 0x07, 0xa1, 0x20] }
  const sig: Ev = { tick: 0, order: -1, data: [0xff, 0x58, 0x04, 0x04, 0x02, 0x18, 0x08] }

  const fill = (events: Ev[], bars: number[][][], channel: number) => {
    bars.forEach((bar, barIndex) => {
      bar.forEach((pitches, beat) => {
        const tick = (barIndex * 4 + beat) * ppq
        for (const midi of pitches) addNote(events, tick, midi, dur, channel)
      })
    })
  }

  let tracks: Uint8Array[]
  if (kind === 'single') {
    const events: Ev[] = [tempo, sig, { tick: 0, order: 0, data: metaName('Piano') }]
    fill(events, LEFT, 0)
    fill(events, RIGHT, 0)
    tracks = [encodeTrack(events)]
  } else {
    const right: Ev[] = [tempo, sig, { tick: 0, order: 0, data: metaName('Right') }]
    const left: Ev[] = [{ tick: 0, order: 0, data: metaName('Left') }]
    fill(right, RIGHT, 0)
    fill(left, LEFT, 1)
    tracks = [encodeTrack(right), encodeTrack(left)]
  }

  const header = new Uint8Array(14)
  header.set([0x4d, 0x54, 0x68, 0x64, 0x00, 0x00, 0x00, 0x06, 0x00, kind === 'single' ? 0 : 1], 0)
  header[10] = 0
  header[11] = tracks.length
  header[12] = (ppq >> 8) & 255
  header[13] = ppq & 255

  const total = header.length + tracks.reduce((sum, track) => sum + track.length, 0)
  const out = new Uint8Array(total)
  out.set(header, 0)
  let offset = header.length
  for (const track of tracks) {
    out.set(track, offset)
    offset += track.length
  }
  return out
}
