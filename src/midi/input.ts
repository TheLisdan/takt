const STORAGE_KEY = 'piano-wait:device'
const STORAGE_OUTPUT = 'piano-wait:output'

export type MidiHandler = (pitch: number, velocity: number, down: boolean) => void

export class MidiIn {
  private access: MIDIAccess | null = null
  private input: MIDIInput | null = null
  private output: MIDIOutput | null = null
  private handler: MidiHandler = () => {}
  onDevices: () => void = () => {}

  get connected(): boolean {
    return this.access !== null
  }

  async connect(): Promise<string | null> {
    if (!navigator.requestMIDIAccess) {
      return 'В этом браузере нет Web MIDI. Откройте страницу в Chrome или Edge.'
    }
    try {
      this.access = await navigator.requestMIDIAccess()
    } catch {
      return 'Доступ к MIDI закрыт. Разрешите его в браузере и нажмите ещё раз.'
    }
    this.access.onstatechange = () => {
      this.rebind()
      this.rebindOutput()
      this.onDevices()
    }
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved && this.access.inputs.has(saved)) this.select(saved)
    this.restoreOutput()
    this.onDevices()
    return null
  }

  devices(): { id: string; name: string }[] {
    if (!this.access) return []
    const list: { id: string; name: string }[] = []
    for (const input of this.access.inputs.values()) {
      list.push({ id: input.id, name: input.name || 'MIDI' })
    }
    return list
  }

  get selectedId(): string | null {
    return this.input?.id ?? null
  }

  outputs(): { id: string; name: string }[] {
    if (!this.access) return []
    const list: { id: string; name: string }[] = []
    for (const output of this.access.outputs.values()) {
      list.push({ id: output.id, name: output.name || 'MIDI' })
    }
    return list
  }

  get selectedOutputId(): string | null {
    return this.output?.id ?? null
  }

  get outputName(): string | null {
    return this.output?.name ?? null
  }

  get hasOutput(): boolean {
    return this.output !== null
  }

  selectOutput(id: string | null) {
    if (!id) {
      this.output = null
      localStorage.setItem(STORAGE_OUTPUT, 'browser')
      return
    }
    if (!this.access) return
    const next = this.access.outputs.get(id) ?? null
    this.output = next
    if (!next) {
      localStorage.setItem(STORAGE_OUTPUT, 'browser')
      return
    }
    localStorage.setItem(STORAGE_OUTPUT, id)
  }

  note(pitch: number, down: boolean, velocity: number): boolean {
    if (!this.output) return false
    const status = down ? 0x90 : 0x80
    const vel = down ? Math.max(1, Math.min(127, velocity | 0)) : 0
    try {
      this.output.send([status, pitch & 127, vel])
      return true
    } catch {
      this.output = null
      return false
    }
  }

  silenceOutput() {
    if (!this.output) return
    try {
      this.output.send([0xb0, 123, 0])
    } catch {
      this.output = null
    }
  }

  select(id: string) {
    if (!this.access) return
    if (this.input) this.input.onmidimessage = null
    const next = this.access.inputs.get(id) ?? null
    this.input = next
    if (!next) {
      localStorage.removeItem(STORAGE_KEY)
      return
    }
    next.onmidimessage = (event) => this.onMessage(event)
    localStorage.setItem(STORAGE_KEY, id)
  }

  setHandler(handler: MidiHandler) {
    this.handler = handler
  }

  private restoreOutput() {
    if (!this.access) return
    const saved = localStorage.getItem(STORAGE_OUTPUT)
    if (saved === 'browser') {
      this.output = null
      return
    }
    if (saved && this.access.outputs.has(saved)) {
      this.output = this.access.outputs.get(saved) ?? null
      return
    }
    let best: MIDIOutput | null = null
    let bestRank = 0
    for (const output of this.access.outputs.values()) {
      const rank = outputRank(output.name || '')
      if (rank > bestRank) {
        best = output
        bestRank = rank
      }
    }
    this.output = bestRank > 0 ? best : null
  }

  private rebindOutput() {
    if (!this.access || !this.output) return
    if (!this.access.outputs.has(this.output.id)) {
      this.output = null
      return
    }
    const live = this.access.outputs.get(this.output.id)
    if (live && live !== this.output) this.output = live
  }

  private rebind() {
    if (!this.access || !this.input) return
    if (!this.access.inputs.has(this.input.id)) {
      this.input.onmidimessage = null
      this.input = null
      return
    }
    const live = this.access.inputs.get(this.input.id)
    if (live && live !== this.input) {
      this.input.onmidimessage = null
      this.input = live
      live.onmidimessage = (event) => this.onMessage(event)
    }
  }

  private onMessage(event: MIDIMessageEvent) {
    const data = event.data
    if (!data || data.length < 3) return
    const cmd = data[0] & 0xf0
    const pitch = data[1]
    const velocity = data[2]
    if (cmd === 0x90 && velocity > 0) this.handler(pitch, velocity, true)
    else if (cmd === 0x80 || (cmd === 0x90 && velocity === 0)) this.handler(pitch, velocity, false)
  }
}

function outputRank(name: string): number {
  if (/fa[\s-]?0?6/i.test(name)) return 2
  if (/roland/i.test(name)) return 1
  return 0
}
