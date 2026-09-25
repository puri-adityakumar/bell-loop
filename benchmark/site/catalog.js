const results = document.querySelector('#results')
const empty = document.querySelector('#empty')
const count = document.querySelector('#count')
const filter = document.querySelector('#filter')
const generated = document.querySelector('#generated')

const number = new Intl.NumberFormat('en-US')
const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 })

function element(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function duration(ms) {
  const value = Number(ms) || 0
  const hours = Math.floor(value / 3600000)
  const minutes = Math.floor((value % 3600000) / 60000)
  return `${hours}h ${minutes}m`
}

function stat(label, value) {
  const box = element('div', 'stat')
  box.append(element('dt', '', label), element('dd', '', value))
  return box
}

function card(entry) {
  const article = element('article', 'result-card')
  const head = element('div', 'result-card__head')
  const heading = element('div')
  heading.append(element('h2', '', `${entry.provider} / ${entry.model}`), element('div', 'result-card__branch', entry.branch))
  head.append(heading, element('span', 'result-card__status', entry.status))
  const body = element('div', 'result-card__body')
  body.append(element('p', 'result-card__summary', `${entry.pass_count ?? 0} passes · ${number.format(entry.persisted_agents ?? 0)} persisted agents · ${duration(entry.active_agent_time_ms)} aggregate agent time`))
  const stats = element('dl', 'stats')
  stats.append(
    stat('Non-cache tokens', compact.format(entry.non_cache_tokens ?? 0)),
    stat('Total tokens', compact.format(entry.total_tokens ?? 0)),
    stat('Reasoning tokens', compact.format(entry.reasoning_tokens ?? 0)),
    stat('Cost', `$${Number(entry.cost_usd ?? 0).toFixed(2)}`),
    stat('Wall time', duration(entry.wall_time_ms)),
    stat('Task calls', number.format(entry.task_calls ?? 0)),
    stat('Pure checks', entry.pure_checks ?? 0),
    stat('World checks', entry.world_checks ?? 0),
  )
  body.append(stats)
  const links = element('nav', 'links')
  const readme = element('a', '', 'Read result README')
  readme.href = entry.readme_url
  const branch = element('a', '', 'Open branch')
  branch.href = entry.branch_url
  links.append(readme, branch)
  if (entry.deployed_url) {
    const deploy = element('a', '', 'Open deployment')
    deploy.href = entry.deployed_url
    links.append(deploy)
  }
  body.append(links)
  if (Array.isArray(entry.screenshots) && entry.screenshots.length) {
    const gallery = element('div', 'gallery')
    for (const source of entry.screenshots) {
      const figure = element('figure')
      const image = element('img')
      image.src = source
      image.alt = source.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ')
      image.loading = 'lazy'
      figure.append(image, element('figcaption', '', image.alt))
      gallery.append(figure)
    }
    body.append(gallery)
  }
  article.append(head, body)
  return article
}

function render(entries) {
  const selected = filter.value
  const visible = selected === 'all' ? entries : entries.filter((entry) => entry.status === selected)
  results.replaceChildren(...visible.map(card))
  empty.hidden = visible.length > 0
  count.textContent = `${visible.length} result${visible.length === 1 ? '' : 's'}`
}

async function load() {
  try {
    const response = await fetch('catalog.json')
    if (!response.ok) throw new Error(`catalog request failed: ${response.status}`)
    const catalog = await response.json()
    const entries = Array.isArray(catalog.entries) ? catalog.entries : []
    generated.textContent = `Generated ${new Date(catalog.generated_at).toLocaleString()}`
    filter.addEventListener('change', () => render(entries))
    render(entries)
  } catch (error) {
    generated.textContent = 'Catalog unavailable'
    results.replaceChildren(element('p', 'empty', error.message))
  }
}

load()
