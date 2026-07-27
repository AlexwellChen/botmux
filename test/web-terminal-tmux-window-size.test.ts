import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const workerSource = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8')

describe('web terminal tmux attach sizing', () => {
  it('restores responsive tmux sizing before spawning the phone-sized attach', () => {
    const attachBlockStart = workerSource.indexOf('const startAttach = (cols: number, rows: number)')
    const attachBlockEnd = workerSource.indexOf("cp = pty.spawn('tmux'", attachBlockStart)
    expect(attachBlockStart).toBeGreaterThan(-1)
    expect(attachBlockEnd).toBeGreaterThan(attachBlockStart)

    const beforeSpawn = workerSource.slice(attachBlockStart, attachBlockEnd)
    expect(beforeSpawn).toContain("['set-option', '-t', tmuxTarget, 'window-size', 'latest']")
  })
})
