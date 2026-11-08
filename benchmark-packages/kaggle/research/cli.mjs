#!/usr/bin/env node
import { cli, isMain } from './lib/common.mjs'

const commands = ['prepare', 'project', 'research', 'checkpoint', 'report', 'refit', 'mlebench', 'provider']

export async function main() {
  const command = process.argv[2]
  if (command === '--help' || command === '-h') {
    console.log(`Usage: hitch-analysis <${commands.join('|')}> [options]`)
    return
  }
  if (!commands.includes(command)) throw new Error(`Expected a command: ${commands.join(', ')}`)
  process.argv.splice(2, 1)
  await (await import(`./${command}.mjs`)).main()
}

if (isMain(import.meta.url)) cli(main)
