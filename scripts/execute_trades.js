/**
 * Execute Trading Actions
 *
 * Actions:
 * 1. RIVN - Trim 50% (bearish protection before earnings)
 * 2. SNAP - Buy ~$500 position (post-earnings momentum)
 */

const { initVaultFromSecure, getSecret } = require('../security/vault_loader');

const BASE_URL = 'https://paper-api.alpaca.markets/v2';

async function main() {
  console.log('=== TRADE EXECUTION ===\n');

  // Initialize vault
  console.log('Initializing vault...');
  initVaultFromSecure();

  // Get credentials
  const apiKey = getSecret('ALPACA_API_KEY', 'trading-agent');
  const apiSecret = getSecret('ALPACA_API_SECRET', 'trading-agent');

  if (!apiKey || !apiSecret) {
    console.error('ERROR: Alpaca credentials not found in vault');
    process.exit(1);
  }

  const headers = {
    'APCA-API-KEY-ID': apiKey,
    'APCA-API-SECRET-KEY': apiSecret,
    'Content-Type': 'application/json'
  };

  console.log('Credentials loaded.\n');

  // 1. Get account info
  console.log('--- ACCOUNT STATUS ---');
  const accRes = await fetch(`${BASE_URL}/account`, { headers });
  const account = await accRes.json();
  console.log(`Equity: $${parseFloat(account.equity).toFixed(2)}`);
  console.log(`Cash: $${parseFloat(account.cash).toFixed(2)}`);
  console.log(`Buying Power: $${parseFloat(account.buying_power).toFixed(2)}\n`);

  // 2. Get current positions
  console.log('--- CURRENT POSITIONS ---');
  const posRes = await fetch(`${BASE_URL}/positions`, { headers });
  const positions = await posRes.json();

  if (positions.length === 0) {
    console.log('No open positions\n');
  } else {
    for (const p of positions) {
      const pnl = parseFloat(p.unrealized_pl);
      const pnlPct = parseFloat(p.unrealized_plpc) * 100;
      console.log(`${p.symbol}: ${p.qty} shares @ $${parseFloat(p.avg_entry_price).toFixed(2)}`);
      console.log(`  Current: $${parseFloat(p.current_price).toFixed(2)} | P/L: $${pnl.toFixed(2)} (${pnlPct.toFixed(1)}%)`);
    }
    console.log('');
  }

  // 3. Check market status
  const clockRes = await fetch(`${BASE_URL}/clock`, { headers });
  const clock = await clockRes.json();
  console.log(`Market: ${clock.is_open ? 'OPEN' : 'CLOSED'}\n`);

  // 4. ACTION 1: RIVN Trim (if we have a position)
  console.log('--- ACTION 1: RIVN TRIM ---');
  const rivnPosition = positions.find(p => p.symbol === 'RIVN');

  if (rivnPosition) {
    const currentQty = parseInt(rivnPosition.qty);
    const trimQty = Math.floor(currentQty / 2);

    if (trimQty > 0) {
      console.log(`Current RIVN position: ${currentQty} shares`);
      console.log(`Trimming 50%: Selling ${trimQty} shares`);

      const trimOrder = {
        symbol: 'RIVN',
        qty: trimQty.toString(),
        side: 'sell',
        type: 'market',
        time_in_force: 'day'
      };

      const trimRes = await fetch(`${BASE_URL}/orders`, {
        method: 'POST',
        headers,
        body: JSON.stringify(trimOrder)
      });

      const trimResult = await trimRes.json();

      if (trimResult.id) {
        console.log(`✅ RIVN TRIM ORDER PLACED`);
        console.log(`   Order ID: ${trimResult.id}`);
        console.log(`   Status: ${trimResult.status}`);
      } else {
        console.log(`❌ RIVN trim failed: ${JSON.stringify(trimResult)}`);
      }
    } else {
      console.log('RIVN position too small to trim');
    }
  } else {
    console.log('No RIVN position found - skipping trim');
  }

  console.log('');

  // 5. ACTION 2: SNAP Buy
  console.log('--- ACTION 2: SNAP ENTRY ---');

  // Get SNAP quote to calculate shares
  const snapQuoteRes = await fetch(`https://data.alpaca.markets/v2/stocks/SNAP/quotes/latest`, { headers });
  const snapQuote = await snapQuoteRes.json();
  const snapPrice = parseFloat(snapQuote.quote?.ap || snapQuote.quote?.bp || 6.25);

  // Calculate shares for ~$500 position
  const targetAmount = 500;
  const snapQty = Math.floor(targetAmount / snapPrice);

  console.log(`SNAP Price: ~$${snapPrice.toFixed(2)}`);
  console.log(`Target: $${targetAmount} → ${snapQty} shares`);

  if (snapQty > 0) {
    const snapOrder = {
      symbol: 'SNAP',
      qty: snapQty.toString(),
      side: 'buy',
      type: 'market',
      time_in_force: 'day'
    };

    const snapRes = await fetch(`${BASE_URL}/orders`, {
      method: 'POST',
      headers,
      body: JSON.stringify(snapOrder)
    });

    const snapResult = await snapRes.json();

    if (snapResult.id) {
      console.log(`✅ SNAP BUY ORDER PLACED`);
      console.log(`   Order ID: ${snapResult.id}`);
      console.log(`   Status: ${snapResult.status}`);
      console.log(`   Qty: ${snapQty} shares`);
    } else {
      console.log(`❌ SNAP buy failed: ${JSON.stringify(snapResult)}`);
    }
  } else {
    console.log('Could not calculate SNAP quantity');
  }

  console.log('\n--- EXECUTION COMPLETE ---');

  // 6. Final position check
  console.log('\nWaiting 3s for orders to process...');
  await new Promise(r => setTimeout(r, 3000));

  const finalPosRes = await fetch(`${BASE_URL}/positions`, { headers });
  const finalPositions = await finalPosRes.json();

  console.log('\n--- UPDATED POSITIONS ---');
  if (finalPositions.length === 0) {
    console.log('No open positions');
  } else {
    for (const p of finalPositions) {
      const pnl = parseFloat(p.unrealized_pl);
      const pnlPct = parseFloat(p.unrealized_plpc) * 100;
      console.log(`${p.symbol}: ${p.qty} shares @ $${parseFloat(p.avg_entry_price).toFixed(2)} | P/L: ${pnlPct.toFixed(1)}%`);
    }
  }

  // Check orders
  const ordersRes = await fetch(`${BASE_URL}/orders?status=all&limit=5`, { headers });
  const recentOrders = await ordersRes.json();

  console.log('\n--- RECENT ORDERS ---');
  for (const o of recentOrders.slice(0, 5)) {
    console.log(`${o.side.toUpperCase()} ${o.qty} ${o.symbol} - ${o.status} (${o.type})`);
  }
}

main().catch(err => {
  console.error('FATAL ERROR:', err.message);
  process.exit(1);
});
