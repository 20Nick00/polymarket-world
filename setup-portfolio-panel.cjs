#!/usr/bin/env node
// setup-portfolio-panel.js
// Run from the polymarket-world (worldmonitor fork) directory to add the Portfolio panel.

const fs = require('fs');
const path = require('path');

// ── Helpers ──

function bail(msg) {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

function readFile(rel) {
  const abs = path.resolve(rel);
  if (!fs.existsSync(abs)) bail(`File not found: ${abs}`);
  return fs.readFileSync(abs, 'utf-8');
}

function writeFile(rel, content) {
  fs.writeFileSync(path.resolve(rel), content, 'utf-8');
  console.log(`  ✓ wrote ${rel}`);
}

function insertAfter(content, anchor, insertion, label) {
  const idx = content.indexOf(anchor);
  if (idx === -1) bail(`Could not find anchor in ${label}: ${JSON.stringify(anchor)}`);
  const end = idx + anchor.length;
  return content.slice(0, end) + insertion + content.slice(end);
}

// ── Sanity check ──

const pkgPath = path.resolve('package.json');
if (!fs.existsSync(pkgPath)) {
  bail('No package.json found. Run this script from the worldmonitor / polymarket-world directory.');
}

// ── 1. Create PolyPortfolioPanel.ts ──

console.log('\n1. Creating src/components/PolyPortfolioPanel.ts');

const panelTs = `import { Panel } from './Panel';
import { escapeHtml } from '@/utils/sanitize';
import { t } from '@/services/i18n';

interface Position {
  conditionId: string;
  title: string;
  outcome: string;
  size: number;
  avgPrice: number;
  currentValue: number;
  cashPnl: number;
  percentPnl: number;
  redeemed: boolean;
  asset?: string;
}

interface MidpointResponse {
  [tokenId: string]: string;
}

type SortKey = 'market' | 'side' | 'size' | 'cost' | 'now' | 'value' | 'pnl' | 'pnlPct' | 'alloc';

export class PolyPortfolioPanel extends Panel {
  private wallet = '';
  private positions: Position[] = [];
  private livePrices: Record<string, number> = {};
  private totalValue = 0;
  private sortKey: SortKey = 'value';
  private sortAsc = false;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private priceTimer: ReturnType<typeof setInterval> | null = null;
  private countdown = 0;
  private countdownTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    super({
      id: 'poly-portfolio',
      title: t('panels.polyPortfolio'),
      showCount: true,
    });

    this.wallet = localStorage.getItem('poly-trader-wallet') || '';

    // Event delegation for sort headers and wallet input
    this.element.addEventListener('click', (e: Event) => {
      const target = e.target as HTMLElement;

      // Sort header click
      const sortEl = target.closest('[data-sort]') as HTMLElement | null;
      if (sortEl) {
        const key = sortEl.dataset.sort as SortKey;
        if (key === this.sortKey) {
          this.sortAsc = !this.sortAsc;
        } else {
          this.sortKey = key;
          this.sortAsc = false;
        }
        this.render();
        return;
      }

      // Load button click
      if (target.closest('.poly-load-btn')) {
        const input = this.element.querySelector('.poly-wallet-input') as HTMLInputElement | null;
        if (input) {
          this.wallet = input.value.trim();
          localStorage.setItem('poly-trader-wallet', this.wallet);
          this.loadPositions();
        }
      }
    });

    // Row click for market selection
    this.element.addEventListener('click', (e: Event) => {
      const row = (e.target as HTMLElement).closest('.poly-row[data-cid]') as HTMLElement | null;
      if (row) {
        const cid = row.dataset.cid || '';
        const title = row.dataset.title || '';
        this.element.dispatchEvent(
          new CustomEvent('poly-select-market', { bubbles: true, detail: { conditionId: cid, title } })
        );
      }
    });

    if (this.wallet) {
      this.loadPositions();
    } else {
      this.render();
    }
  }

  private async loadPositions(): Promise<void> {
    if (!this.wallet) {
      this.render();
      return;
    }

    this.showLoading();

    try {
      // Fetch positions
      const posRes = await fetch(
        \`https://data-api.polymarket.com/positions?user=\${encodeURIComponent(this.wallet)}&limit=500&sizeThreshold=0\`,
        { signal: this.signal }
      );
      if (!posRes.ok) throw new Error(\`Positions API \${posRes.status}\`);
      const raw: Position[] = await posRes.json();
      this.positions = raw.filter((p) => !p.redeemed);

      // Fetch portfolio value
      const valRes = await fetch(
        \`https://data-api.polymarket.com/value?user=\${encodeURIComponent(this.wallet)}\`,
        { signal: this.signal }
      );
      if (valRes.ok) {
        const valData = await valRes.json();
        this.totalValue = typeof valData === 'number' ? valData : parseFloat(valData?.value ?? '0') || 0;
      }

      // Fetch live prices
      await this.fetchLivePrices();

      this.setCount(this.positions.length);
      this.startTimers();
      this.render();
    } catch (err) {
      if (this.isAbortError(err)) return;
      this.showError('Failed to load positions', () => this.loadPositions(), 30);
    }
  }

  private async fetchLivePrices(): Promise<void> {
    const tokenIds = this.positions
      .map((p) => p.asset)
      .filter((id): id is string => !!id);
    if (tokenIds.length === 0) return;

    // Batch 50 at a time
    for (let i = 0; i < tokenIds.length; i += 50) {
      const batch = tokenIds.slice(i, i + 50);
      try {
        const res = await fetch(
          \`https://clob.polymarket.com/midpoints?token_ids=\${batch.join(',')}\`,
          { signal: this.signal }
        );
        if (res.ok) {
          const data: MidpointResponse = await res.json();
          for (const [id, price] of Object.entries(data)) {
            this.livePrices[id] = parseFloat(price);
          }
        }
      } catch {
        // Ignore individual batch failures
      }
    }
  }

  private startTimers(): void {
    this.stopTimers();

    // Refresh positions every 60s
    this.refreshTimer = setInterval(() => this.loadPositions(), 60_000);

    // Refresh prices every 15s
    this.priceTimer = setInterval(async () => {
      await this.fetchLivePrices();
      this.render();
    }, 15_000);

    // Countdown in header
    this.countdown = 15;
    this.countdownTimer = setInterval(() => {
      this.countdown = this.countdown <= 0 ? 15 : this.countdown - 1;
    }, 1000);
  }

  private stopTimers(): void {
    if (this.refreshTimer) { clearInterval(this.refreshTimer); this.refreshTimer = null; }
    if (this.priceTimer) { clearInterval(this.priceTimer); this.priceTimer = null; }
    if (this.countdownTimer) { clearInterval(this.countdownTimer); this.countdownTimer = null; }
  }

  private getSorted(): Position[] {
    const dir = this.sortAsc ? 1 : -1;
    return [...this.positions].sort((a, b) => {
      switch (this.sortKey) {
        case 'market': return dir * a.title.localeCompare(b.title);
        case 'side': return dir * a.outcome.localeCompare(b.outcome);
        case 'size': return dir * (a.size - b.size);
        case 'cost': return dir * (a.avgPrice - b.avgPrice);
        case 'now': {
          const aPrice = this.getLivePrice(a);
          const bPrice = this.getLivePrice(b);
          return dir * (aPrice - bPrice);
        }
        case 'value': {
          const aVal = this.getValue(a);
          const bVal = this.getValue(b);
          return dir * (aVal - bVal);
        }
        case 'pnl': return dir * (a.cashPnl - b.cashPnl);
        case 'pnlPct': return dir * (a.percentPnl - b.percentPnl);
        case 'alloc': {
          const aAlloc = this.totalValue > 0 ? this.getValue(a) / this.totalValue : 0;
          const bAlloc = this.totalValue > 0 ? this.getValue(b) / this.totalValue : 0;
          return dir * (aAlloc - bAlloc);
        }
        default: return 0;
      }
    });
  }

  private getLivePrice(p: Position): number {
    if (p.asset) {
      const price = this.livePrices[p.asset];
      if (price !== undefined) return price;
    }
    return p.size > 0 ? p.currentValue / p.size : 0;
  }

  private getValue(p: Position): number {
    return p.size * this.getLivePrice(p);
  }

  private fmt(n: number, d = 2): string {
    if (Math.abs(n) >= 1000) return n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: d });
    return n.toFixed(d);
  }

  private fmtCompact(n: number): string {
    if (n >= 1_000_000) return \`$\${(n / 1_000_000).toFixed(1)}M\`;
    if (n >= 1_000) return \`$\${(n / 1_000).toFixed(0)}K\`;
    return \`$\${n.toFixed(0)}\`;
  }

  private render(): void {
    if (!this.wallet) {
      this.setContent(\`
        <div class="poly-wallet-row">
          <input class="poly-wallet-input" type="text" placeholder="Enter wallet address (0x...)" value="\${escapeHtml(this.wallet)}" />
          <button class="poly-load-btn">Load</button>
        </div>
        <div class="poly-empty">Enter a Polymarket wallet address to track positions</div>
      \`);
      return;
    }

    if (this.positions.length === 0) {
      this.setContent(\`
        <div class="poly-wallet-row">
          <input class="poly-wallet-input" type="text" placeholder="Wallet address" value="\${escapeHtml(this.wallet)}" />
          <button class="poly-load-btn">Load</button>
          <span class="poly-countdown">\${this.countdown}s</span>
        </div>
        <div class="poly-empty">No open positions found</div>
      \`);
      return;
    }

    const sorted = this.getSorted();

    // Summary metrics
    const totalVal = this.totalValue;
    const unrealizedPnl = this.positions.reduce((s, p) => s + p.cashPnl, 0);
    const winners = this.positions.filter((p) => p.cashPnl > 0).length;
    const winRate = this.positions.length > 0 ? (winners / this.positions.length) * 100 : 0;
    const bestPnl = Math.max(...this.positions.map((p) => p.cashPnl), 0);

    const arrow = (key: SortKey) =>
      this.sortKey === key ? (this.sortAsc ? ' \\u25B2' : ' \\u25BC') : '';

    const rows = sorted
      .map((p) => {
        const livePrice = this.getLivePrice(p);
        const value = this.getValue(p);
        const alloc = totalVal > 0 ? (value / totalVal) * 100 : 0;
        const pnlCls = p.cashPnl >= 0 ? 'poly-pnl-pos' : 'poly-pnl-neg';
        const pctCls = p.percentPnl >= 0 ? 'poly-pnl-pos' : 'poly-pnl-neg';
        const allocCls = alloc > 20 ? 'poly-alloc-warn' : '';
        const sideCls = p.outcome === 'Yes' ? 'poly-side-yes' : 'poly-side-no';

        return \`<div class="poly-row" data-cid="\${escapeHtml(p.conditionId)}" data-title="\${escapeHtml(p.title)}">
          <div class="poly-cell poly-cell-market" title="\${escapeHtml(p.title)}">\${escapeHtml(p.title)}</div>
          <div class="poly-cell poly-cell-side \${sideCls}">\${p.outcome.toUpperCase()}</div>
          <div class="poly-cell poly-cell-right">\${this.fmt(p.size, 0)}</div>
          <div class="poly-cell poly-cell-right">\${(p.avgPrice * 100).toFixed(1)}\\u00A2</div>
          <div class="poly-cell poly-cell-right">\${(livePrice * 100).toFixed(1)}\\u00A2</div>
          <div class="poly-cell poly-cell-right">$\${this.fmt(value)}</div>
          <div class="poly-cell poly-cell-right \${pnlCls}">\${p.cashPnl >= 0 ? '+' : ''}$\${this.fmt(p.cashPnl)}</div>
          <div class="poly-cell poly-cell-right \${pctCls}">\${p.percentPnl >= 0 ? '+' : ''}\${this.fmt(p.percentPnl, 1)}%</div>
          <div class="poly-cell poly-cell-right \${allocCls}">\${this.fmt(alloc, 1)}%</div>
        </div>\`;
      })
      .join('');

    this.setContent(\`
      <div class="poly-wallet-row">
        <input class="poly-wallet-input" type="text" placeholder="Wallet address" value="\${escapeHtml(this.wallet)}" />
        <button class="poly-load-btn">Load</button>
        <span class="poly-countdown">\${this.countdown}s</span>
      </div>
      <div class="poly-metrics">
        <span class="poly-metric"><b>VALUE</b> \${this.fmtCompact(totalVal)}</span>
        <span class="poly-metric \${unrealizedPnl >= 0 ? 'poly-pnl-pos' : 'poly-pnl-neg'}"><b>P&amp;L</b> \${unrealizedPnl >= 0 ? '+' : ''}$\${this.fmt(unrealizedPnl)}</span>
        <span class="poly-metric"><b>POS</b> \${this.positions.length}</span>
        <span class="poly-metric"><b>WIN</b> \${winRate.toFixed(0)}%</span>
        <span class="poly-metric poly-pnl-pos"><b>BEST</b> +$\${this.fmt(bestPnl)}</span>
      </div>
      <div class="poly-table-header">
        <div class="poly-cell poly-cell-market" data-sort="market">Market\${arrow('market')}</div>
        <div class="poly-cell poly-cell-side" data-sort="side">Side\${arrow('side')}</div>
        <div class="poly-cell poly-cell-right" data-sort="size">Size\${arrow('size')}</div>
        <div class="poly-cell poly-cell-right" data-sort="cost">Cost\${arrow('cost')}</div>
        <div class="poly-cell poly-cell-right" data-sort="now">Now\${arrow('now')}</div>
        <div class="poly-cell poly-cell-right" data-sort="value">Value\${arrow('value')}</div>
        <div class="poly-cell poly-cell-right" data-sort="pnl">P&amp;L($)\${arrow('pnl')}</div>
        <div class="poly-cell poly-cell-right" data-sort="pnlPct">P&amp;L(%)\${arrow('pnlPct')}</div>
        <div class="poly-cell poly-cell-right" data-sort="alloc">Alloc\${arrow('alloc')}</div>
      </div>
      <div class="poly-table-body">\${rows}</div>
    \`);
  }

  public destroy(): void {
    this.stopTimers();
    super.destroy();
  }
}
`;

const panelDir = path.resolve('src/components');
if (!fs.existsSync(panelDir)) bail('src/components directory not found. Are you in the right repo?');
writeFile('src/components/PolyPortfolioPanel.ts', panelTs);

// ── 2. Modify src/components/index.ts ──

console.log('2. Modifying src/components/index.ts');

let indexTs = readFile('src/components/index.ts');
const indexAnchor = "export * from './PredictionPanel';";
if (indexTs.includes("export * from './PolyPortfolioPanel'")) {
  console.log('  (already present, skipping)');
} else {
  indexTs = insertAfter(indexTs, indexAnchor, "\nexport * from './PolyPortfolioPanel';", 'index.ts');
  writeFile('src/components/index.ts', indexTs);
}

// ── 3. Modify src/app/panel-layout.ts ──

console.log('3. Modifying src/app/panel-layout.ts');

let panelLayout = readFile('src/app/panel-layout.ts');

// 3a. Add import
const importAnchor = 'PredictionPanel,';
if (panelLayout.includes('PolyPortfolioPanel')) {
  console.log('  (import already present, skipping)');
} else {
  panelLayout = insertAfter(panelLayout, importAnchor, '\n  PolyPortfolioPanel,', 'panel-layout.ts (import)');
}

// 3b. Add createPanel call
const createAnchor = "this.createPanel('polymarket', () => new PredictionPanel());";
if (panelLayout.includes("this.createPanel('poly-portfolio'")) {
  console.log('  (createPanel already present, skipping)');
} else {
  panelLayout = insertAfter(panelLayout, createAnchor, "\n    this.createPanel('poly-portfolio', () => new PolyPortfolioPanel());", 'panel-layout.ts (createPanel)');
}

writeFile('src/app/panel-layout.ts', panelLayout);

// ── 4. Modify src/config/panels.ts ──

console.log('4. Modifying src/config/panels.ts');

let panelsTs = readFile('src/config/panels.ts');
const portfolioEntry = "  'poly-portfolio': { name: 'Portfolio', enabled: true, priority: 1 },";

if (panelsTs.includes("'poly-portfolio'")) {
  console.log('  (already present, skipping)');
} else {
  // Find ALL polymarket: entries and insert after each one (reverse order to keep indices valid)
  const polyAnchor = "polymarket:";
  const indices = [];
  let searchFrom = 0;
  while (true) {
    const idx = panelsTs.indexOf(polyAnchor, searchFrom);
    if (idx === -1) break;
    indices.push(idx);
    searchFrom = idx + polyAnchor.length;
  }
  if (indices.length === 0) bail("Could not find any 'polymarket:' in panels.ts");

  function endOfLine(str, from) {
    const nl = str.indexOf('\n', from);
    return nl === -1 ? str.length : nl;
  }

  // Insert in reverse order so earlier indices stay valid
  for (let i = indices.length - 1; i >= 0; i--) {
    const eol = endOfLine(panelsTs, indices[i]);
    panelsTs = panelsTs.slice(0, eol) + '\n' + portfolioEntry + panelsTs.slice(eol);
  }

  writeFile('src/config/panels.ts', panelsTs);
}

// ── 5. Modify src/config/commands.ts ──

console.log('5. Modifying src/config/commands.ts');

let commandsTs = readFile('src/config/commands.ts');
const portfolioCmd = "  { id: 'panel:poly-portfolio', keywords: ['portfolio', 'positions', 'pnl', 'wallet', 'polymarket'], label: 'Panel: Portfolio', icon: '\uD83D\uDCBC', category: 'panels' },";

if (commandsTs.includes("'panel:poly-portfolio'")) {
  console.log('  (already present, skipping)');
} else {
  // Find the polymarket command entry line
  const cmdAnchor = "id: 'panel:polymarket'";
  const cmdIdx = commandsTs.indexOf(cmdAnchor);
  if (cmdIdx === -1) bail("Could not find panel:polymarket command entry in commands.ts");
  // Find end of that line (closing },)
  let cmdLineEnd = commandsTs.indexOf('\n', cmdIdx);
  if (cmdLineEnd === -1) cmdLineEnd = commandsTs.length;
  commandsTs = commandsTs.slice(0, cmdLineEnd) + '\n' + portfolioCmd + commandsTs.slice(cmdLineEnd);
  writeFile('src/config/commands.ts', commandsTs);
}

// ── 6. Modify src/locales/en.json ──

console.log('6. Modifying src/locales/en.json');

let enJson = readFile('src/locales/en.json');

if (enJson.includes('"polyPortfolio"')) {
  console.log('  (already present, skipping)');
} else {
  const localeAnchor = '"polymarket": "Predictions",';
  const localeIdx = enJson.indexOf(localeAnchor);
  if (localeIdx === -1) bail('Could not find "polymarket": "Predictions" in en.json');
  const localeEnd = localeIdx + localeAnchor.length;
  enJson = enJson.slice(0, localeEnd) + '\n    "polyPortfolio": "Portfolio",' + enJson.slice(localeEnd);
  writeFile('src/locales/en.json', enJson);
}

// ── 7. Append CSS to src/styles/panels.css ──

console.log('7. Appending portfolio CSS to src/styles/panels.css');

let panelsCss = readFile('src/styles/panels.css');

if (panelsCss.includes('.poly-wallet-row')) {
  console.log('  (already present, skipping)');
} else {
  const css = `
/* ── Poly Portfolio Panel ── */
.poly-wallet-row {
  display: flex;
  gap: 6px;
  align-items: center;
  padding: 6px 0;
}
.poly-wallet-input {
  flex: 1;
  background: var(--bg-secondary, rgba(255,255,255,0.05));
  border: 1px solid var(--border, rgba(255,255,255,0.1));
  border-radius: 4px;
  color: var(--text, #e2e8f0);
  font-family: inherit;
  font-size: 10px;
  padding: 4px 8px;
  outline: none;
}
.poly-wallet-input:focus { border-color: var(--accent, #3b82f6); }
.poly-load-btn {
  background: var(--accent, #3b82f6);
  color: #fff;
  border: none;
  border-radius: 4px;
  font-size: 10px;
  font-weight: 600;
  padding: 4px 10px;
  cursor: pointer;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.poly-load-btn:hover { opacity: 0.85; }
.poly-countdown {
  font-size: 9px;
  color: var(--text-muted, rgba(255,255,255,0.35));
  font-variant-numeric: tabular-nums;
  min-width: 22px;
  text-align: right;
}
.poly-empty {
  text-align: center;
  color: var(--text-muted, rgba(255,255,255,0.35));
  font-size: 11px;
  padding: 24px 8px;
}
.poly-metrics {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  padding: 6px 0;
  border-bottom: 1px solid var(--border, rgba(255,255,255,0.1));
  margin-bottom: 4px;
}
.poly-metric {
  font-size: 10px;
  color: var(--text-dim, rgba(255,255,255,0.55));
  font-variant-numeric: tabular-nums;
}
.poly-metric b {
  text-transform: uppercase;
  letter-spacing: 0.05em;
  font-size: 9px;
  margin-right: 3px;
  color: var(--text-muted, rgba(255,255,255,0.35));
}
.poly-table-header {
  display: grid;
  grid-template-columns: 1fr 36px 52px 48px 48px 60px 60px 48px 44px;
  gap: 2px;
  padding: 4px 0;
  border-bottom: 1px solid var(--border, rgba(255,255,255,0.1));
  position: sticky;
  top: 0;
  background: var(--bg-panel, var(--bg, #0a0a0f));
  z-index: 1;
}
.poly-table-header .poly-cell {
  font-size: 9px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-muted, rgba(255,255,255,0.35));
  cursor: pointer;
  user-select: none;
  white-space: nowrap;
}
.poly-table-header .poly-cell:hover { color: var(--text, #e2e8f0); }
.poly-table-body { overflow-y: auto; }
.poly-row {
  display: grid;
  grid-template-columns: 1fr 36px 52px 48px 48px 60px 60px 48px 44px;
  gap: 2px;
  padding: 3px 0;
  border-bottom: 1px solid rgba(255,255,255,0.03);
  cursor: pointer;
  transition: background 0.15s;
}
.poly-row:hover { background: rgba(255,255,255,0.04); }
.poly-cell {
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-dim, rgba(255,255,255,0.55));
}
.poly-cell-market { color: var(--text, #e2e8f0); }
.poly-cell-side { font-weight: 600; font-size: 9px; }
.poly-cell-right { text-align: right; }
.poly-side-yes { color: var(--semantic-normal, #22c55e); }
.poly-side-no { color: var(--semantic-critical, #ef4444); }
.poly-pnl-pos { color: var(--semantic-normal, #22c55e); }
.poly-pnl-neg { color: var(--semantic-critical, #ef4444); }
.poly-alloc-warn { color: var(--semantic-elevated, #f59e0b); }
`;
  panelsCss += css;
  writeFile('src/styles/panels.css', panelsCss);
}

console.log('\nDone! Portfolio panel has been set up.\n');
