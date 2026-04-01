const http = require('http');
const post = (cmd) => new Promise((res, rej) => {
  const d = JSON.stringify({ command: cmd, timeout: 60 });
  const r = http.request({
    hostname: '192.168.0.108', port: 8765, path: '/exec',
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-API-Key': 'qcc_node_api_2026' }
  }, resp => {
    let b = ''; resp.on('data', c => b += c); resp.on('end', () => res(JSON.parse(b)));
  });
  r.on('error', rej); r.write(d); r.end();
});

const pyScript = `
import json, glob, os
from collections import defaultdict

base = '/home/jupiter/Lvl3Quant/data/processed/oos_wf_fill_sim/comprehensive_sweep'
configs = defaultdict(lambda: {'pnl': 0, 'trades': 0, 'days': 0})

for f in glob.glob(os.path.join(base, '*.json')):
    name = '_'.join(os.path.basename(f).split('_')[1:])
    d = json.load(open(f))
    configs[name]['pnl'] += d.get('total_pnl_dollars', 0)
    configs[name]['trades'] += d.get('total_trades', 0)
    configs[name]['days'] += 1

ranked = sorted(configs.items(), key=lambda x: x[1]['pnl'], reverse=True)
print('TOP 20 CONFIGS BY PNL:')
for name, d in ranked[:20]:
    avg = round(d['pnl'] / max(1, d['days']))
    n = name.replace('.json', '')
    print('  ' + n + ': PnL=$' + str(round(d['pnl'])) + ' | ' + str(d['trades']) + ' trades | ' + str(d['days']) + ' days | avg=$' + str(avg) + '/day')

print()
print('BOTTOM 5 (worst):')
for name, d in ranked[-5:]:
    avg = round(d['pnl'] / max(1, d['days']))
    n = name.replace('.json', '')
    print('  ' + n + ': PnL=$' + str(round(d['pnl'])) + ' | ' + str(d['trades']) + ' trades | ' + str(d['days']) + ' days | avg=$' + str(avg) + '/day')

print()
print('Total configs: ' + str(len(configs)))
`;

(async () => {
  // Write script to Jupiter
  await post("cat > /tmp/agg_sweep.py << 'PYEOF'\n" + pyScript + "\nPYEOF");
  // Run it
  const r = await post('python3 /tmp/agg_sweep.py');
  console.log(r.stdout || r.stderr || JSON.stringify(r));
})();
