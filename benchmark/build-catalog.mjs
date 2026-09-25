import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const outputPath = resolve(root, 'benchmark/site/catalog.json')
const repository = process.env.BENCHMARK_REPOSITORY ?? 'https://github.com/puri-adityakumar/bell-loop'

function parseValue(value) {
  const trimmed = value.trim()
  if (trimmed === '') return ''
  if (trimmed === 'true') return true
  if (trimmed === 'false') return false
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) return JSON.parse(trimmed)
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed)
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function parseFrontmatter(readme) {
  const match = readme.match(/^---\n([\s\S]*?)\n---(?:\n|$)/)
  if (!match) return null
  const metadata = {}
  for (const line of match[1].split('\n')) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue
    const separator = line.indexOf(':')
    if (separator < 1) continue
    const key = line.slice(0, separator).trim()
    metadata[key] = parseValue(line.slice(separator + 1))
  }
  return metadata
}

function getBranches() {
  const output = execFileSync('git', ['for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes/origin'], {
    cwd: root,
    encoding: 'utf8',
  })
  return [...new Set(output.trim().split('\n').filter(Boolean).map((branch) => branch.replace(/^origin\//, '')))]
}

function readResult(branch) {
  let readme
  try {
    const currentBranch = execFileSync('git', ['branch', '--show-current'], { cwd: root, encoding: 'utf8' }).trim()
    readme = branch === currentBranch
      ? readFileSync(resolve(root, 'README.md'), 'utf8')
      : execFileSync('git', ['show', `${branch}:README.md`], { cwd: root, encoding: 'utf8' })
  } catch {
    return null
  }
  const metadata = parseFrontmatter(readme)
  if (!metadata || metadata.benchmark !== 'bell-loop' || !metadata.result_id) return null
  const required = ['result_id', 'provider', 'model', 'branch', 'base_branch', 'base_commit', 'status', 'non_cache_tokens', 'total_tokens']
  for (const key of required) {
    if (metadata[key] === undefined || metadata[key] === '') throw new Error(`${branch}: missing README frontmatter field ${key}`)
  }
  if (metadata.base_branch !== 'main') throw new Error(`${branch}: base_branch must be main`)
  return {
    ...metadata,
    repository,
    readme_url: `${repository}/blob/${branch}/README.md`,
    branch_url: `${repository}/tree/${branch}`,
    screenshots: Array.isArray(metadata.screenshots) ? metadata.screenshots.map((name) => `screenshots/${name}`) : [],
  }
}

const entries = getBranches()
  .filter((branch) => branch !== 'main')
  .map((branch) => readResult(branch))
  .filter(Boolean)
  .sort((a, b) => a.result_id.localeCompare(b.result_id))

const catalog = {
  schemaVersion: 1,
  generated_at: new Date().toISOString(),
  base_branch: 'main',
  entries,
}

writeFileSync(outputPath, `${JSON.stringify(catalog, null, 2)}\n`)
console.log(`wrote ${entries.length} result entries to ${outputPath}`)
