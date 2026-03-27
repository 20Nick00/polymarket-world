import { Panel } from './Panel';
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
        `https://data-api.polymarket.com/positions?user=${encodeURIComponent(this.wallet)}&limit=500&sizeThreshold=0`,
        { signal: this.signal }
      );
      if (!posRes.ok) throw new Error(`Positions API ${posRes.status}`);
      const raw: Position[] = await posRes.json();
      this.positions = raw.filter((p) => !p.redeemed);

      // Fetch portfolio value
      const valRes = await fetch(
        `https://data-api.polymarket.com/value?user=${encodeURIComponent(this.wallet)}`,
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
          `https://clob.polymarket.com/midpoints?token_ids=${batch.join(',')}`,
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
    if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}K`;
    return `$${n.toFixed(0)}`;
  }

  private render(): void {
    if (!this.wallet) {
      this.setContent(`
        <div class="poly-wallet-row">
          <input class="poly-wallet-input" type="text" placeholder="Enter wallet address (0x...)" value="${escapeHtml(this.wallet)}" />
          <button class="poly-load-btn">Load</button>
        </div>
        <div class="poly-empty">Enter a Polymarket wallet address to track positions</div>
      `);
      return;
    }

    if (this.positions.length === 0) {
      this.setContent(`
        <div class="poly-wallet-row">
          <input class="poly-wallet-input" type="text" placeholder="Wallet address" value="${escapeHtml(this.wallet)}" />
          <button class="poly-load-btn">Load</button>
          <span class="poly-countdown">${this.countdown}s</span>
        </div>
        <div class="poly-empty">No open positions found</div>
      `);
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
      this.sortKey === key ? (this.sortAsc ? ' \u25B2' : ' \u25BC') : '';

    const rows = sorted
      .map((p) => {
        const livePrice = this.getLivePrice(p);
        const value = this.getValue(p);
        const alloc = totalVal > 0 ? (value / totalVal) * 100 : 0;
        const pnlCls = p.cashPnl >= 0 ? 'poly-pnl-pos' : 'poly-pnl-neg';
        const pctCls = p.percentPnl >= 0 ? 'poly-pnl-pos' : 'poly-pnl-neg';
        const allocCls = alloc > 20 ? 'poly-alloc-warn' : '';
        const sideCls = p.outcome === 'Yes' ? 'poly-side-yes' : 'poly-side-no';

        return `<div class="poly-row" data-cid="${escapeHtml(p.conditionId)}" data-title="${escapeHtml(p.title)}">
          <div class="poly-cell poly-cell-market" title="${escapeHtml(p.title)}">${escapeHtml(p.title)}</div>
          <div class="poly-cell poly-cell-side ${sideCls}">${p.outcome.toUpperCase()}</div>
          <div class="poly-cell poly-cell-right">${this.fmt(p.size, 0)}</div>
          <div class="poly-cell poly-cell-right">${(p.avgPrice * 100).toFixed(1)}\u00A2</div>
          <div class="poly-cell poly-cell-right">${(livePrice * 100).toFixed(1)}\u00A2</div>
          <div class="poly-cell poly-cell-right">$${this.fmt(value)}</div>
          <div class="poly-cell poly-cell-right ${pnlCls}">${p.cashPnl >= 0 ? '+' : ''}$${this.fmt(p.cashPnl)}</div>
          <div class="poly-cell poly-cell-right ${pctCls}">${p.percentPnl >= 0 ? '+' : ''}${this.fmt(p.percentPnl, 1)}%</div>
          <div class="poly-cell poly-cell-right ${allocCls}">${this.fmt(alloc, 1)}%</div>
        </div>`;
      })
      .join('');

    this.setContent(`
      <div class="poly-wallet-row">
        <input class="poly-wallet-input" type="text" placeholder="Wallet address" value="${escapeHtml(this.wallet)}" />
        <button class="poly-load-btn">Load</button>
        <span class="poly-countdown">${this.countdown}s</span>
      </div>
      <div class="poly-metrics">
        <span class="poly-metric"><b>VALUE</b> ${this.fmtCompact(totalVal)}</span>
        <span class="poly-metric ${unrealizedPnl >= 0 ? 'poly-pnl-pos' : 'poly-pnl-neg'}"><b>P&amp;L</b> ${unrealizedPnl >= 0 ? '+' : ''}$${this.fmt(unrealizedPnl)}</span>
        <span class="poly-metric"><b>POS</b> ${this.positions.length}</span>
        <span class="poly-metric"><b>WIN</b> ${winRate.toFixed(0)}%</span>
        <span class="poly-metric poly-pnl-pos"><b>BEST</b> +$${this.fmt(bestPnl)}</span>
      </div>
      <div class="poly-table-header">
        <div class="poly-cell poly-cell-market" data-sort="market">Market${arrow('market')}</div>
        <div class="poly-cell poly-cell-side" data-sort="side">Side${arrow('side')}</div>
        <div class="poly-cell poly-cell-right" data-sort="size">Size${arrow('size')}</div>
        <div class="poly-cell poly-cell-right" data-sort="cost">Cost${arrow('cost')}</div>
        <div class="poly-cell poly-cell-right" data-sort="now">Now${arrow('now')}</div>
        <div class="poly-cell poly-cell-right" data-sort="value">Value${arrow('value')}</div>
        <div class="poly-cell poly-cell-right" data-sort="pnl">P&amp;L($)${arrow('pnl')}</div>
        <div class="poly-cell poly-cell-right" data-sort="pnlPct">P&amp;L(%)${arrow('pnlPct')}</div>
        <div class="poly-cell poly-cell-right" data-sort="alloc">Alloc${arrow('alloc')}</div>
      </div>
      <div class="poly-table-body">${rows}</div>
    `);
  }

  public destroy(): void {
    this.stopTimers();
    super.destroy();
  }
}
