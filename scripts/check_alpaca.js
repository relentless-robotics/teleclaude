/**
 * Quick Alpaca Account Check
 */
const { vault } = require('../security/vault');

async function main() {
  vault.init(process.env.VAULT_MASTER_KEY);

  const apiKey = vault.getInternal('ALPACA_API_KEY');
  const apiSecret = vault.getInternal('ALPACA_API_SECRET');
  const headers = {
    'APCA-API-KEY-ID': apiKey,
    'APCA-API-SECRET-KEY': apiSecret
  };

  // Get positions
  const posRes = await fetch('https://paper-api.alpaca.markets/v2/positions', { headers });
  const positions = await posRes.json();

  console.log('=== CURRENT POSITIONS ===');
  if (positions.length === 0) {
    console.log('  No open positions');
  } else {
    positions.forEach(p => {
      const pnl = parseFloat(p.unrealized_pl);
      const pnlPct = parseFloat(p.unrealized_plpc) * 100;
      const mktVal = parseFloat(p.market_value);
      console.log(`  ${p.symbol}: ${p.qty} shares`);
      console.log(`    Entry: $${parseFloat(p.avg_entry_price).toFixed(2)} | Current: $${parseFloat(p.current_price).toFixed(2)}`);
      console.log(`    P/L: $${pnl.toFixed(2)} (${pnlPct.toFixed(1)}%) | Value: $${mktVal.toFixed(2)}`);
    });
  }

  // Get open orders
  const ordRes = await fetch('https://paper-api.alpaca.markets/v2/orders?status=open', { headers });
  const orders = await ordRes.json();

  console.log('\n=== OPEN ORDERS ===');
  if (orders.length === 0) {
    console.log('  No open orders');
  } else {
    orders.forEach(o => {
      console.log(`  ${o.side.toUpperCase()} ${o.qty} ${o.symbol} @ ${o.type} - ${o.status}`);
    });
  }

  // Get account
  const accRes = await fetch('https://paper-api.alpaca.markets/v2/account', { headers });
  const account = await accRes.json();

  console.log('\n=== ACCOUNT SUMMARY ===');
  console.log(`  Status: ${account.status}`);
  console.log(`  Equity: $${parseFloat(account.equity).toFixed(2)}`);
  console.log(`  Cash: $${parseFloat(account.cash).toFixed(2)}`);
  console.log(`  Buying Power: $${parseFloat(account.buying_power).toFixed(2)}`);
}

main().catch(console.error);
